import { TreeNode, Turn, ToolCall } from './types';

// Renders the selected turn range as a faithful chronological transcript for the
// compaction LLM: full prompt/answer text plus tool results, in node order.
// 결과_branchport_vs_v2_비교.md 실측: 턴을 400/300자 다이제스트로 눌러 넣으면
// tool_result가 입력에서 사라져, 세션 중 반박된 가설이 확정 사실로 굳는 오류가
// 구조적으로 재현된다 — 그래서 다이제스트가 아니라 원문 슬라이스를 입력한다.

const DEFAULT_BUDGET = 120_000; // 트랜스크립트 전체 문자 예산 (~40k 토큰대)

// 도구 종류·성공/실패별 결과 캡. 실측(10턴 구성비): tool 결과가 전체의 68%,
// 그중 Read가 58% — 반면 반박 증거는 에러·검증성 출력(Bash/Grep)에 몰려 있다.
// 에러와 검증 출력은 전문 유지, 내용 덩어리(Read)와 확인성 응답(Edit/Write)만
// 줄여서 증거 소실 없이 입력을 다이어트한다.
const CAPS = {
  error: 1500,     // 실패 결과: 어떤 도구든 전문 — 반박 증거의 핵심
  evidence: 1500,  // Bash·Grep 등 검증성 출력
  content: 300,    // Read·Glob 등 내용 조회 — 어시스턴트 본문이 핵심을 재서술함
  ack: 200,        // Edit·Write 등 확인성 응답 ("성공" 한 줄이면 충분)
};
const TIGHT = { error: 800, evidence: 400, content: 150, ack: 100 }; // 예산 초과 시

const CONTENT_TOOLS = new Set(['Read', 'Glob', 'NotebookRead', 'WebFetch', 'ListMcpResourcesTool']);
const ACK_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite', 'TaskStop', 'ToolSearch']);

type Caps = typeof CAPS;

function capFor(t: ToolCall, caps: Caps): number {
  if (t.isError) return caps.error;
  if (CONTENT_TOOLS.has(t.name)) return caps.content;
  if (ACK_TOOLS.has(t.name)) return caps.ack;
  return caps.evidence;
}

function indexNodes(roots: TreeNode[]): Map<string, TreeNode> {
  const idx = new Map<string, TreeNode>();
  const walk = (n: TreeNode) => { idx.set(n.id, n); n.children.forEach(walk); };
  roots.forEach(walk);
  return idx;
}

// turns.ts collapse()와 동일한 규칙으로 턴의 노드 체인을 복원한다:
// 단일 A 자식이 이어지는 동안 같은 턴이다.
function chainOf(first: TreeNode): TreeNode[] {
  const chain: TreeNode[] = [first];
  let cur = first;
  while (cur.children.length === 1 && cur.children[0].type === 'A' && !cur.children[0].isForkRoot) {
    cur = cur.children[0];
    chain.push(cur);
  }
  return chain;
}

function renderTool(t: ToolCall, toolResults: Map<string, string>, caps: Caps): string {
  const lines = [`[TOOL] ${t.name} — ${t.inputPreview || '(no input preview)'}`];
  const full = t.toolUseId ? toolResults.get(t.toolUseId) : undefined;
  const raw = full ?? t.resultPreview ?? '';
  const cap = capFor(t, caps);
  const body = raw.slice(0, cap);
  if (body) lines.push(`[${t.isError ? 'TOOL ERROR' : 'TOOL RESULT'}] ${body}${raw.length > cap ? `…(truncated ${raw.length}→${cap} chars)` : ''}`);
  else if (t.isError) lines.push('[TOOL ERROR] (no result text)');
  return lines.join('\n');
}

function renderNode(n: TreeNode, toolResults: Map<string, string>, caps: Caps): string {
  const parts: string[] = [];
  if (n.type === 'Q') {
    if (n.text) parts.push(`[USER]\n${n.text}`);
  } else {
    if (n.text) parts.push(`[ASSISTANT]\n${n.text}`);
    for (const t of n.tools) parts.push(renderTool(t, toolResults, caps));
  }
  if (n.interrupted) parts.push('[NOTE] user interrupted this turn');
  return parts.join('\n');
}

function renderOnce(range: Turn[], idx: Map<string, TreeNode>, toolResults: Map<string, string>, caps: Caps): string {
  const blocks: string[] = [];
  range.forEach((turn, i) => {
    const first = idx.get(turn.id);
    if (!first) return;
    const head = `===== TURN ${i + 1}/${range.length} · ${(turn.timestamp ?? '').slice(0, 16)}` +
      `${turn.isForkRoot ? ` · fork(${turn.forkName ?? 'subagent'}) 진입` : ''} =====`;
    const body = chainOf(first).map(n => renderNode(n, toolResults, caps)).filter(Boolean).join('\n');
    blocks.push(`${head}\n${body}`);
  });
  return blocks.join('\n\n');
}

export function renderTranscript(
  range: Turn[],
  roots: TreeNode[],
  toolResults: Map<string, string>,
  budget = DEFAULT_BUDGET,
): string {
  const idx = indexNodes(roots);
  let out = renderOnce(range, idx, toolResults, CAPS);
  if (out.length > budget) out = renderOnce(range, idx, toolResults, TIGHT);
  if (out.length > budget) {
    // 그래도 초과하면 앞쪽(오래된 턴)을 잘라내되, 잘렸음을 명시해 모델이
    // 빠진 구간을 추측으로 메우지 않게 한다.
    out = `[NOTE] transcript exceeds budget — oldest part omitted below this line\n…\n` + out.slice(out.length - budget);
  }
  return out;
}
