import { createHash } from 'node:crypto';
import { TreeNode, Turn, Phase } from './types';

// Collapses a raw Q/A node chain into "turns" (one real user prompt + everything
// the agent did until the next real prompt or a genuine tree branch), the way a
// human reads a session — while keeping true branch points (forks, retries,
// parallel tool-result paths) as real turn-tree edges instead of flattening them
// away like a plain linear timeline would.

function phaseOf(tools: TreeNode['tools']): Phase {
  const has = (cat: string) => tools.some(t => t.category === cat);
  if (has('edit')) return 'edit';
  if (has('exec')) return 'exec';
  if (has('explore')) return 'explore';
  if (has('other')) return 'exec';
  return 'chat';
}

function aggregate(chain: TreeNode[]): Turn {
  const first = chain[0];
  const last = chain[chain.length - 1];
  const answerParts = chain.filter(n => n.type === 'A' && n.text).map(n => n.text);
  const tools = chain.flatMap(n => n.tools);
  const files: string[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    if (t.filePath && !seen.has(t.filePath)) { seen.add(t.filePath); files.push(t.filePath); }
  }

  const prompt = first.type === 'Q' ? first.text : '(계속)';
  const answer = answerParts.join(' ').slice(0, 3000);
  // 내용 기반 해시 — 라벨 캐시 키. endTimestamp를 섞어 진행 중이던 턴이
  // 완결되어 내용이 자라면 해시가 바뀌고 자연히 재라벨링된다.
  const hash = createHash('sha256')
    .update([first.sessionId, first.timestamp ?? '', last.timestamp ?? '', prompt.slice(0, 500), answer.slice(0, 300)].join(' '))
    .digest('hex').slice(0, 16);

  return {
    id: first.id,
    hash,
    phase: phaseOf(tools),
    prompt,
    answer,
    headline: (first.type === 'Q' ? first.preview : last.preview) || '(내용 없음)',
    timestamp: first.timestamp,
    endTimestamp: last.timestamp,
    sessionId: first.sessionId,
    isForkRoot: false,
    forkName: null,
    tools,
    toolCount: tools.length,
    delegated: tools.some(t => t.category === 'deleg'),
    hasError: tools.some(t => t.isError),
    hasImage: chain.some(n => n.hasImage),
    interrupted: chain.some(n => n.interrupted),
    files,
    outputTokens: chain.reduce((s, n) => s + n.outputTokens, 0),
    gapMin: null,
    compactBefore: false,
    children: [],
  };
}

// 끼어든 메시지(queue-operation)의 도착 시각 — 이 지점에서 A-체인을 끊어
// 각 메시지가 자기만의 턴(질문-답변 쌍)을 갖게 한다. 안 끊으면 한 작업 턴 동안
// 여러 번 끼어든 메시지 중 하나만 자리를 얻고 나머지는 유실된다(전수 추적으로 실측).
type SplitQueue = Map<string, { ts: string; used: boolean }[]>;

function collapse(node: TreeNode, splits: SplitQueue): Turn[] {
  if (node.isForkRoot && node.type === 'A') {
    // this node is the parent's spawning tool_use replayed at the top of the
    // fork's own transcript — not new content. Unwrap straight to its real
    // first prompt and tag that turn as the fork's entry point instead.
    const child = node.children[0];
    if (!child) return [];
    const turns = collapse(child, splits);
    for (const t of turns) { t.isForkRoot = true; t.forkName = node.forkName; }
    return turns;
  }

  const chain: TreeNode[] = [node];
  let cur = node;
  const sq = splits.get(node.sessionId);
  while (cur.children.length === 1 && cur.children[0].type === 'A' && !cur.children[0].isForkRoot) {
    const c = cur.children[0];
    if (sq && c.timestamp && node.timestamp) { // 체인 머리에 시각이 없으면 하한이 무의미 — 분할 안 함
      const q = sq.find(x => !x.used && x.ts > node.timestamp! && x.ts <= c.timestamp!);
      if (q) { q.used = true; break; } // 이 지점 이전에 끼어든 메시지 있음 — 여기서 새 턴 시작
    }
    cur = c;
    chain.push(cur);
  }

  const turn = aggregate(chain);
  // 새 포맷에선 접합점이 Q(에이전트의 첫 프롬프트)라 위 A-언랩 경로를 안 타고
  // aggregate가 플래그를 되살리지 않음 — 체인 머리의 포크 표시를 여기서 승계
  if (node.isForkRoot) { turn.isForkRoot = true; turn.forkName = node.forkName; }
  turn.children = cur.children.flatMap(ch => collapse(ch, splits));
  return [turn];
}

function linkGaps(turns: Turn[], compactBoundaries: string[], parentEndTs: string | null) {
  for (const t of turns) {
    if (parentEndTs && t.timestamp) {
      t.gapMin = Math.max(0, Math.round((Date.parse(t.timestamp) - Date.parse(parentEndTs)) / 60000));
      t.compactBefore = compactBoundaries.some(ts => ts > parentEndTs! && ts <= t.timestamp!);
    }
    linkGaps(t.children, compactBoundaries, t.endTimestamp);
  }
}

// 작업 중 끼어든 사용자 메시지(queue-operation) 복원: uuid가 없어 체인에 못 들어간
// 텍스트를, "(계속)"으로 남은 턴에 시간 순서로 배정한다 — 턴 시작 직전에 큐에 들어온
// 가장 최근 메시지가 그 턴의 실제 질문이다.
function applyQueuedPrompts(turns: Turn[], queued: { ts: string; text: string; session: string }[]) {
  if (!queued.length) return;
  const flat: Turn[] = [];
  const walk = (ts: Turn[]) => { for (const t of ts) { flat.push(t); walk(t.children); } };
  walk(turns);
  flat.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  // 큐에 들어갔던 메시지가 나중에 정식 질문 레코드로도 기록되는 경우가 있다(실측).
  // 이미 진짜 턴이 된 질문을 다시 배정하면 같은 질문이 두 턴에 겹치므로 걸러낸다.
  const norm = (s: string) => s.replace(/\s+/g, ' ').slice(0, 80);
  const realPrompts = new Set(flat.filter(t => t.prompt !== '(계속)').map(t => norm(t.prompt)));
  const remaining = queued.filter(q => !realPrompts.has(norm(q.text)));
  for (const t of flat) {
    if (t.prompt !== '(계속)' || !t.timestamp) continue;
    let pick = -1;
    for (let i = 0; i < remaining.length; i++) {
      const q = remaining[i];
      if (q.ts > t.timestamp) break;
      if (q.session !== t.sessionId) continue;
      // 6시간 넘게 묵은 큐는 이 턴의 질문이 아니다(세션이 끊겼거나 답이 없던 메시지)
      if (Date.parse(t.timestamp) - Date.parse(q.ts) > 6 * 3600_000) continue;
      pick = i; break; // 가장 이른 미배정 메시지 — 연속으로 끼어든 경우에도 순서 보존
    }
    if (pick < 0) continue;
    const q = remaining.splice(pick, 1)[0];
    t.prompt = q.text.slice(0, 3000);
    t.headline = q.text.replace(/\s+/g, ' ').slice(0, 60);
    // 내용이 바뀌었으니 라벨 캐시 키도 다시 — 복원된 질문 기준으로 제목이 생성되게
    t.hash = createHash('sha256')
      .update([t.sessionId, t.timestamp ?? '', t.endTimestamp ?? '', t.prompt.slice(0, 500), t.answer.slice(0, 300)].join(' '))
      .digest('hex').slice(0, 16);
  }
}

export function buildTurnForest(
  roots: TreeNode[],
  compactBoundaries: string[],
  queuedPrompts: { ts: string; text: string; session: string }[] = [],
): Turn[] {
  const splits: SplitQueue = new Map();
  for (const q of queuedPrompts) {
    let arr = splits.get(q.session);
    if (!arr) { arr = []; splits.set(q.session, arr); }
    arr.push({ ts: q.ts, used: false });
  }
  for (const arr of splits.values()) arr.sort((a, b) => a.ts.localeCompare(b.ts));

  const turns = roots.flatMap(r => collapse(r, splits));
  linkGaps(turns, compactBoundaries, null);
  applyQueuedPrompts(turns, queuedPrompts);
  return turns;
}
