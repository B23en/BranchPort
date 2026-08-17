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
type Caps = { error: number; evidence: number; content: number; ack: number };
const CAPS: Caps = {
  error: 1500,     // 실패 결과: 어떤 도구든 전문 — 반박 증거의 핵심
  evidence: 1500,  // Bash·Grep 등 검증성 출력
  content: 300,    // Read·Glob 등 내용 조회 — 어시스턴트 본문이 핵심을 재서술함
  ack: 200,        // Edit·Write 등 확인성 응답 ("성공" 한 줄이면 충분)
};
const TIGHT: Caps = { error: 800, evidence: 400, content: 150, ack: 100 }; // 최종 단계

// 적응형 절단 (2026-08-15) — 예산 초과 시 균등 TIGHT 한 번이 아니라, 증거 가치가 낮은
// 종류부터 단계적으로 줄인다. 어떤 단계든 "에러 > 검증 출력 > 내용 조회 > 확인 응답"
// 순으로 살아남는다. 사다리는 순서대로 시도해 예산에 처음 드는 단계를 쓴다.
const LADDER: Caps[] = [
  CAPS,                                                   // 0단: 기본
  { ...CAPS, content: TIGHT.content, ack: TIGHT.ack },    // 1단: 내용 조회·확인 응답만
  { ...CAPS, content: TIGHT.content, ack: TIGHT.ack, evidence: TIGHT.evidence }, // 2단: +검증 출력
  TIGHT,                                                  // 3단: 에러까지
];
// 예산이 남을 때 에러 결과만 더 살린다 — 에러는 대개 짧고 반박 증거의 밀도가 가장 높다.
const ERROR_RELIEF = 4000;

const CONTENT_TOOLS = new Set(['Read', 'Glob', 'NotebookRead', 'WebFetch', 'ListMcpResourcesTool']);
const ACK_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite', 'TaskStop', 'ToolSearch']);


function capFor(t: ToolCall, caps: Caps): number {
  if (t.isError) return caps.error;
  if (CONTENT_TOOLS.has(t.name)) return caps.content;
  if (ACK_TOOLS.has(t.name)) return caps.ack;
  return caps.evidence;
}

export function indexNodes(roots: TreeNode[]): Map<string, TreeNode> {
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

// 절단 형태 (2026-08-15): 에러·검증 출력은 앞+뒤를 남긴다 — 테스트 요약·"N errors"·
// 스택 최하단·마지막 실패 줄이 출력 끝에 몰리는데 앞만 남기면 정확히 그 부분이 사라진다.
// 내용 조회(Read)·확인 응답은 앞만으로 충분하다(본문이 재서술·"성공" 한 줄).
// 표기는 프롬프트의 truncation rule이 인식하는 "…(truncated …)" 형태를 유지한다.
function clip(raw: string, cap: number, headTail: boolean): string {
  if (raw.length <= cap) return raw;
  if (!headTail) return raw.slice(0, cap) + `…(truncated ${raw.length}→${cap} chars)`;
  const head = Math.ceil(cap * 0.6);
  let tailStart = raw.length - (cap - head);
  // 꼬리는 가능하면 줄 경계에서 시작 (잘린 반 줄이 식별자를 오염시키지 않게)
  const nl = raw.indexOf('\n', tailStart);
  if (nl !== -1 && nl - tailStart < 120) tailStart = nl + 1;
  return raw.slice(0, head) + `\n…(truncated ${raw.length - head - (raw.length - tailStart)} chars in the middle)…\n` + raw.slice(tailStart);
}

function renderTool(t: ToolCall, toolResults: Map<string, string>, caps: Caps): string {
  const lines = [`[TOOL] ${t.name} — ${t.inputPreview || '(no input preview)'}`];
  const full = t.toolUseId ? toolResults.get(t.toolUseId) : undefined;
  const raw = full ?? t.resultPreview ?? '';
  const headTail = t.isError || (!CONTENT_TOOLS.has(t.name) && !ACK_TOOLS.has(t.name));
  const body = clip(raw, capFor(t, caps), headTail);
  if (body) lines.push(`[${t.isError ? 'TOOL ERROR' : 'TOOL RESULT'}] ${body}`);
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

function renderBlocks(range: Turn[], idx: Map<string, TreeNode>, toolResults: Map<string, string>, caps: Caps): string[] {
  const blocks: string[] = [];
  range.forEach((turn, i) => {
    const first = idx.get(turn.id);
    if (!first) return;
    const head = `===== TURN ${i + 1}/${range.length} · ${(turn.timestamp ?? '').slice(0, 16)}` +
      `${turn.isForkRoot ? ` · fork(${turn.forkName ?? 'subagent'}) 진입` : ''} =====`;
    const body = chainOf(first).map(n => renderNode(n, toolResults, caps)).filter(Boolean).join('\n');
    blocks.push(`${head}\n${body}`);
  });
  return blocks;
}

function renderOnce(range: Turn[], idx: Map<string, TreeNode>, toolResults: Map<string, string>, caps: Caps): string {
  return renderBlocks(range, idx, toolResults, caps).join('\n\n');
}

export function renderTranscript(
  range: Turn[],
  roots: TreeNode[],
  toolResults: Map<string, string>,
  budget = DEFAULT_BUDGET,
  // 미리 만든 노드 인덱스 — 같은 트리로 여러 번 렌더할 때(용어 부록의 조상 세그먼트화 등)
  // 호출마다 트리 전체를 재인덱싱하면 조상 N × 노드 M의 준2차 비용이 된다
  // (실측 1회 1.35ms · 조상 1,000건 1,117ms, 프로젝트 10배면 동기 블로킹 168초).
  nodeIdx?: Map<string, TreeNode>,
): string {
  const idx = nodeIdx ?? indexNodes(roots);
  // 사다리를 순서대로 내려가며 예산에 처음 드는 단계를 택한다.
  let out = '';
  let caps = LADDER[LADDER.length - 1];
  for (const c of LADDER) {
    out = renderOnce(range, idx, toolResults, c);
    caps = c;
    if (out.length <= budget) break;
  }
  if (out.length <= budget) {
    // 여유가 있으면 에러 결과만 전문에 가깝게 복원 — 예산 안에 들 때만 채택.
    if (caps.error < ERROR_RELIEF) {
      const relieved = renderOnce(range, idx, toolResults, { ...caps, error: ERROR_RELIEF });
      if (relieved.length <= budget) out = relieved;
    }
    return out;
  }
  // 최종 단계로도 초과: 오래된 턴을 통째로 떨어뜨린다 — 턴 중간을 자르면 헤더 없는
  // 파편이 남고, 남은 턴의 "TURN i/N" 번호는 원래 인덱스를 유지해 앵커·evidence
  // 체계(TURN N 참조)가 어긋나지 않게 한다. 빠졌음을 명시해 모델이 추측으로 메우지 않게 한다.
  const blocks = renderBlocks(range, idx, toolResults, caps);
  let dropped = 0;
  let total = blocks.reduce((n, b) => n + b.length + 2, 0);
  while (dropped < blocks.length - 1 && total > budget) { total -= blocks[dropped].length + 2; dropped++; }
  const kept = blocks.slice(dropped).join('\n\n');
  const note = `[NOTE] transcript exceeds budget — TURN 1–${dropped}/${range.length} omitted entirely; the range below starts at TURN ${dropped + 1}\n…\n`;
  if (kept.length + note.length <= budget) return note + kept;
  // 마지막 턴 하나만으로도 초과하는 극단: 예전 방식대로 뒷부분(최신)만 남긴다.
  return `[NOTE] transcript exceeds budget — oldest part omitted below this line\n…\n` + kept.slice(kept.length - budget);
}

// 압축 패키지를 갈래 맥락으로 승계할 때의 절단 — 앞에서 통째로 자르면 md 끝에 있는
// "## 원문 앵커"가 통째로 날아간다(실측: 19,444자 패키지에서 앵커가 18,754자 위치라 잘림).
// 앵커는 갈래 AI가 /expand로 원문을 더 파낼 유일한 경로라, 잘리면 손실 보완 파이프라인의
// 마지막 고리가 끊긴다. 그래서 앞부분(요약층·관련 원문)을 우선 담되 앵커 섹션은 별도로
// 떼어 끝에 반드시 붙인다. 앵커도 길면 자르되 잘렸다는 사실을 표시한다.
const ANCHOR_HEAD = '## 원문 앵커';
export function truncatePackage(md: string, limit: number): string {
  if (md.length <= limit) return md;
  // 마지막 등장을 찾는다 — 앵커는 패키지 md의 마지막 섹션이라 뒤에서 찾는 게 정확하고,
  // 요약층(LLM 자유 서술)이 줄머리에 "## 원문 앵커"를 그대로 인용해도 오탐하지 않는다.
  // parseSummary는 개행을 지우지 않으므로 요약·주의 항목에 이 헤더가 줄머리로 들어올 수
  // 있고, 그때 앞에서 찾으면 진짜 앵커 목록이 통째로 날아간다(이 리포지터리는 자기 세션을
  // 압축하므로 요약이 이 섹션명을 언급할 개연성이 특히 높다).
  const ai = md.lastIndexOf('\n' + ANCHOR_HEAD);
  if (ai < 0) return md.slice(0, limit); // 앵커 섹션이 없는 옛 패키지 — 종전 동작
  let anchor = md.slice(ai + 1);
  const ANCHOR_MAX = Math.min(2_500, Math.floor(limit * 0.2)); // 앵커에 내줄 상한
  if (anchor.length > ANCHOR_MAX) anchor = anchor.slice(0, ANCHOR_MAX) + '\n- …(앵커 목록 일부 생략 — 전체는 패키지 원본 참조)';
  const headBudget = limit - anchor.length - 40;
  if (headBudget <= 0) return md.slice(0, limit);
  const head = md.slice(0, Math.min(ai, headBudget));
  return head + '\n\n…(중략 — 분량 상한)\n\n' + anchor;
}
