import * as fs from 'node:fs';
import { parseSessionFile, ParsedFile } from './parser';
import { listSessionFiles, listForkFiles } from './discover';
import { TreeNode, ToolCall, ParseStats } from './types';

// 최신 포맷 대응: 에이전트 파일에 fork-context-ref 레코드가 없는 경우가 실측으로
// 확인됨(레코드 자체가 사라진 포맷). 대신 부모 세션 쪽에 agentId를 언급하는 레코드가
// 남으므로, 그 레코드의 uuid를 접합점으로 쓴다.
function findAgentRefUuids(filePath: string, agentIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!agentIds.length) return out;
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return out; }
  const remaining = new Set(agentIds);
  for (const line of raw.split('\n')) {
    if (!remaining.size) break;
    for (const id of [...remaining]) {
      if (!line.includes(id)) continue;
      const m = line.match(/"uuid"\s*:\s*"([0-9a-f][0-9a-f-]{30,})"/);
      if (m) { out.set(id, m[1]); remaining.delete(id); }
      // break 없음 — 한 줄이 여러 agentId를 언급해도 각자 첫 언급에 묶인다
    }
  }
  return out;
}

interface Merged {
  allParent: Map<string, string | null>;
  kind: Map<string, 'Q' | 'A'>;
  preview: Map<string, string>;
  text: Map<string, string>;
  timestamp: Map<string, string | null>;
  toolsByOwner: Map<string, ToolCall[]>;
  toolResultFull: Map<string, string>;
  outputTokens: Map<string, number>;
  hasImage: Map<string, boolean>;
  interrupted: Map<string, boolean>;
  ownerSession: Map<string, string>;
  forkRoots: Map<string, { name: string | null }>; // uuid -> fork display info
  compactBoundaries: string[];
  stats: ParseStats;
}

function nearestKeptAncestor(uuid: string, m: Merged): string | null {
  let p = m.allParent.get(uuid) ?? null;
  let guard = 0;
  while (p !== null) {
    if (m.kind.has(p)) return p;
    p = m.allParent.get(p) ?? null;
    if (++guard > 100000) return null;
  }
  return null;
}

export interface Forest {
  roots: TreeNode[];
  stats: ParseStats;
  compactBoundaries: string[];
  // 압축 입력 전용 (API 응답으로 직렬화하지 말 것) — toolUseId -> 전체 결과 텍스트
  toolResults: Map<string, string>;
  queuedPrompts: { ts: string; text: string; session: string }[];
}

export async function buildForest(projectDirName: string): Promise<Forest> {
  const merged: Merged = {
    allParent: new Map(),
    kind: new Map(),
    preview: new Map(),
    text: new Map(),
    timestamp: new Map(),
    toolsByOwner: new Map(),
    toolResultFull: new Map(),
    outputTokens: new Map(),
    hasImage: new Map(),
    interrupted: new Map(),
    ownerSession: new Map(),
    forkRoots: new Map(),
    compactBoundaries: [],
    stats: { totalLines: 0, parseErrors: 0, keptNodes: 0 },
  };

  const queuedPrompts: { ts: string; text: string; session: string }[] = [];

  function absorb(pf: ParsedFile) {
    for (const q of pf.queuedPrompts) queuedPrompts.push({ ...q, session: pf.sessionId });
    for (const [k, v] of pf.allParent) merged.allParent.set(k, v);
    for (const [k, v] of pf.kind) { merged.kind.set(k, v); merged.ownerSession.set(k, pf.sessionId); }
    for (const [k, v] of pf.preview) merged.preview.set(k, v);
    for (const [k, v] of pf.text) merged.text.set(k, v);
    for (const [k, v] of pf.timestamp) merged.timestamp.set(k, v);
    for (const [k, v] of pf.toolsByOwner) merged.toolsByOwner.set(k, v);
    for (const [k, v] of pf.toolResultFull) merged.toolResultFull.set(k, v);
    for (const [k, v] of pf.outputTokens) merged.outputTokens.set(k, v);
    for (const [k, v] of pf.hasImage) merged.hasImage.set(k, v);
    for (const [k, v] of pf.interrupted) merged.interrupted.set(k, v);
    merged.compactBoundaries.push(...pf.compactBoundaries);
    merged.stats.totalLines += pf.stats.totalLines;
    merged.stats.parseErrors += pf.stats.parseErrors;
    // keptNodes is derived from merged.kind.size after all files are absorbed —
    // "continue"/resume sessions duplicate a prior session's uuids verbatim, so a
    // naive per-file sum here would double-count nodes that dedupe to one in the tree.
  }

  const sessions = listSessionFiles(projectDirName);
  for (const s of sessions) {
    const pf = await parseSessionFile(s.filePath, s.sessionId);
    absorb(pf);

    const forkFiles = listForkFiles(projectDirName, s.sessionId);
    const refUuids = findAgentRefUuids(s.filePath, forkFiles.map(f => f.agentId));
    for (const ff of forkFiles) {
      const forkPf = await parseSessionFile(ff.filePath, `${s.sessionId}::${ff.agentId}`);
      absorb(forkPf);

      // find this fork file's local root (the uuid whose original parent was null)
      let localRoot: string | null = null;
      for (const [uuid, parent] of forkPf.allParent) {
        if (parent === null) { localRoot = uuid; break; }
      }
      if (!localRoot) continue;

      // splice the fork's chain onto the parent-session node it was spawned from.
      // 접합점 우선순위: ① fork-context-ref(구 포맷) ② 부모 세션의 agentId 언급 레코드
      //   — 단, 그 지점이 포크 시작보다 늦으면 버린다. /team형 에이전트는 agentId가
      //   "완료 보고" 라인에서만 언급되어(실측 60/218) 몇 시간 뒤에 접합돼 버리기 때문.
      // ③ 시간 폴백 — 에이전트 시작 직전의 부모 세션 마지막 노드
      let startTs = '';
      for (const ts of forkPf.timestamp.values())
        if (ts && (!startTs || ts < startTs)) startTs = ts;
      const keptTsOf = (uuid: string): string | null => {
        const kept = merged.kind.has(uuid) ? uuid : nearestKeptAncestor(uuid, merged);
        return kept ? (merged.timestamp.get(kept) ?? null) : null;
      };

      let anchor: string | null = forkPf.forkContextRef?.parentLastUuid ?? null;
      if (!anchor) {
        const ref = refUuids.get(ff.agentId);
        if (ref) {
          const refTs = keptTsOf(ref);
          if (refTs && startTs && refTs <= startTs) anchor = ref;
        }
      }
      if (!anchor && startTs) { // 포크에 kept 타임스탬프가 없으면 폴백도 무의미 — 건너뜀
        let best: string | null = null, bestTs = '';
        for (const u of merged.kind.keys()) {
          if (merged.ownerSession.get(u) !== s.sessionId) continue;
          const ts = merged.timestamp.get(u) ?? '';
          if (ts && ts <= startTs && ts >= bestTs) { best = u; bestTs = ts; }
        }
        anchor = best;
      }
      if (anchor) {
        merged.allParent.set(localRoot, anchor);
        const name = ff.meta?.name ?? ff.meta?.description ?? 'fork';
        // 포크 표지는 실제 트리 노드가 되는 첫 kept 노드에 단다 — localRoot가
        // teammate-message류로 걸러져 노드가 안 되는 경우가 실측 91/218이라,
        // localRoot에 달면 표지가 조용히 사라진다.
        let markUuid: string | null = forkPf.kind.has(localRoot) ? localRoot : null;
        if (!markUuid) for (const u of forkPf.kind.keys()) { markUuid = u; break; }
        if (markUuid) merged.forkRoots.set(markUuid, { name });
      }
    }
  }

  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const uuid of merged.kind.keys()) {
    const anc = nearestKeptAncestor(uuid, merged);
    if (anc === null) {
      roots.push(uuid);
    } else {
      if (!children.has(anc)) children.set(anc, []);
      children.get(anc)!.push(uuid);
    }
  }

  // stable order by timestamp where available
  function sortKey(u: string): string {
    return merged.timestamp.get(u) ?? '';
  }
  for (const arr of children.values()) arr.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  roots.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  // "[Request interrupted...]" markers live on synthetic records that never
  // become tree nodes themselves — fold the flag onto the nearest visible
  // ancestor so the interruption still shows up somewhere in the tree.
  const interruptedOnKept = new Map<string, boolean>();
  for (const [uuid, val] of merged.interrupted) {
    if (!val) continue;
    const target = merged.kind.has(uuid) ? uuid : nearestKeptAncestor(uuid, merged);
    if (target) interruptedOnKept.set(target, true);
  }

  function build(uuid: string): TreeNode {
    const forkInfo = merged.forkRoots.get(uuid);
    return {
      id: uuid,
      type: merged.kind.get(uuid) as 'Q' | 'A',
      preview: merged.preview.get(uuid) ?? '',
      text: merged.text.get(uuid) ?? '',
      timestamp: merged.timestamp.get(uuid) ?? null,
      sessionId: merged.ownerSession.get(uuid) ?? '',
      isForkRoot: !!forkInfo,
      forkName: forkInfo?.name ?? null,
      tools: merged.toolsByOwner.get(uuid) ?? [],
      outputTokens: merged.outputTokens.get(uuid) ?? 0,
      hasImage: merged.hasImage.get(uuid) ?? false,
      interrupted: interruptedOnKept.get(uuid) ?? false,
      children: (children.get(uuid) ?? []).map(build),
    };
  }

  merged.stats.keptNodes = merged.kind.size;
  return {
    roots: roots.map(build),
    stats: merged.stats,
    compactBoundaries: merged.compactBoundaries.sort(),
    toolResults: merged.toolResultFull,
    queuedPrompts: queuedPrompts.sort((a, b) => a.ts.localeCompare(b.ts)),
  };
}
