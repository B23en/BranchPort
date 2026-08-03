import { parseSessionFile, ParsedFile } from './parser';
import { listSessionFiles, listForkFiles } from './discover';
import { TreeNode, ToolCall, ParseStats } from './types';

interface Merged {
  allParent: Map<string, string | null>;
  kind: Map<string, 'Q' | 'A'>;
  preview: Map<string, string>;
  text: Map<string, string>;
  timestamp: Map<string, string | null>;
  toolsByOwner: Map<string, ToolCall[]>;
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
}

export async function buildForest(projectDirName: string): Promise<Forest> {
  const merged: Merged = {
    allParent: new Map(),
    kind: new Map(),
    preview: new Map(),
    text: new Map(),
    timestamp: new Map(),
    toolsByOwner: new Map(),
    outputTokens: new Map(),
    hasImage: new Map(),
    interrupted: new Map(),
    ownerSession: new Map(),
    forkRoots: new Map(),
    compactBoundaries: [],
    stats: { totalLines: 0, parseErrors: 0, keptNodes: 0 },
  };

  function absorb(pf: ParsedFile) {
    for (const [k, v] of pf.allParent) merged.allParent.set(k, v);
    for (const [k, v] of pf.kind) { merged.kind.set(k, v); merged.ownerSession.set(k, pf.sessionId); }
    for (const [k, v] of pf.preview) merged.preview.set(k, v);
    for (const [k, v] of pf.text) merged.text.set(k, v);
    for (const [k, v] of pf.timestamp) merged.timestamp.set(k, v);
    for (const [k, v] of pf.toolsByOwner) merged.toolsByOwner.set(k, v);
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
    for (const ff of forkFiles) {
      const forkPf = await parseSessionFile(ff.filePath, `${s.sessionId}::${ff.agentId}`);
      absorb(forkPf);

      if (forkPf.forkContextRef) {
        // find this fork file's local root (the uuid whose original parent was null)
        let localRoot: string | null = null;
        for (const [uuid, parent] of forkPf.allParent) {
          if (parent === null) { localRoot = uuid; break; }
        }
        if (localRoot) {
          // splice the fork's chain onto the exact parent-session node it was spawned from
          merged.allParent.set(localRoot, forkPf.forkContextRef.parentLastUuid);
          const name = ff.meta?.name ?? ff.meta?.description ?? 'fork';
          merged.forkRoots.set(localRoot, { name });
        }
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
  return { roots: roots.map(build), stats: merged.stats, compactBoundaries: merged.compactBoundaries.sort() };
}
