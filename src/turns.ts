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

  return {
    id: first.id,
    phase: phaseOf(tools),
    prompt: first.type === 'Q' ? first.text : '(계속)',
    answer: answerParts.join(' ').slice(0, 3000),
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

function collapse(node: TreeNode): Turn[] {
  if (node.isForkRoot && node.type === 'A') {
    // this node is the parent's spawning tool_use replayed at the top of the
    // fork's own transcript — not new content. Unwrap straight to its real
    // first prompt and tag that turn as the fork's entry point instead.
    const child = node.children[0];
    if (!child) return [];
    const turns = collapse(child);
    for (const t of turns) { t.isForkRoot = true; t.forkName = node.forkName; }
    return turns;
  }

  const chain: TreeNode[] = [node];
  let cur = node;
  while (cur.children.length === 1 && cur.children[0].type === 'A' && !cur.children[0].isForkRoot) {
    cur = cur.children[0];
    chain.push(cur);
  }

  const turn = aggregate(chain);
  turn.children = cur.children.flatMap(collapse);
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

export function buildTurnForest(roots: TreeNode[], compactBoundaries: string[]): Turn[] {
  const turns = roots.flatMap(collapse);
  linkGaps(turns, compactBoundaries, null);
  return turns;
}
