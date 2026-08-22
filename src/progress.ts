// ── 압축 진행률 ────────────────────────────────────────────────────────────
// 압축 1회는 [준비 → 용어부록(LLM, 캐시 미스분만) → 본 압축(LLM) → 조립] 순으로 돌고,
// 시간의 대부분은 본 압축 LLM 호출이 차지한다. 그 구간을 "끝날 때까지 대기"가 아니라
// %로 보이게 하려고 `claude -p`의 출력 형식을 json → stream-json(+partial messages)으로
// 바꿔 생성 중인 글자를 세고, 과거 패키지 실측으로 잡은 예상 출력 길이에 대어 비율을 낸다.
//
// LLM 호출 횟수·토큰·비용은 전혀 늘지 않는다 — 같은 호출의 출력을 조각으로 받을 뿐이다
// (실측 8/22: stream-json의 마지막 `result` 이벤트에 total_cost_usd·usage·duration_ms가
// json 래퍼와 동일하게 실려 기존 계측이 그대로 유지됨).
//
// 이 파일은 http·child_process에 의존하지 않는 순수 로직만 담아 테스트에서 require한다.

export type CompactStage = 'prepare' | 'glossary' | 'compact' | 'assemble' | 'done' | 'error';

export interface ProgressState {
  stage: CompactStage;
  pct: number;              // 0~100 정수
  detail: string;           // 사람이 읽는 한 줄 ("본 압축 — 3,200자 생성")
  attempt: number;          // 재시도 번호 (1부터)
  outputChars: number;      // 본 압축에서 지금까지 받은 가시 출력 글자수
  thinkingChars: number;    // 사고 블록 글자수 (진행 신호로만 씀, 내용은 보관하지 않음)
  updatedAt: number;        // Date.now()
}

// 단계별 % 구간. 본 압축이 대부분의 시간을 차지하므로 가장 넓게 잡는다.
// 용어부록은 캐시 전량 히트면 통째로 건너뛰므로(10→30을 즉시 통과) 폭을 작게 둔다.
export const STAGE_BANDS: Record<Exclude<CompactStage, 'error'>, [number, number]> = {
  prepare: [0, 10],
  glossary: [10, 30],
  compact: [30, 95],
  assemble: [95, 99],
  done: [100, 100],
};

// 본 압축 구간(30~95) 안의 사고/출력 배분. 사고는 출력보다 먼저 오고 길이를 예측하기
// 어려워 작은 폭만 준다 — 사고만 길어져도 막대가 38을 넘지 않는다.
const THINK_BAND = 8;     // 30→38
const THINK_SCALE = 4000; // 사고 글자수가 이쯤이면 사고 구간을 거의 채운 것으로 본다

// 예상 출력 토큰 — packages/ 461건 로그-로그 회귀(8/22): out ≈ 20.2 × chars^0.499.
// 실제/예측 비는 p10 0.62 · p50 0.90 · p90 2.09로 편차가 크다. 그래서 선형으로 채우다
// 80%를 넘으면 완만하게 눕히는 곡선(아래 fillCurve)으로 "95%에서 오래 멈춤"을 줄인다.
// 글자 환산 계수 1.66 = LLM이 실제로 낸 summary JSON 글자수 ÷ 예측 토큰의 중앙값
// (462건, p10 0.94 · p90 2.44). 패키지 전체 글자수로 재면 서버가 덧붙이는 facts·anchors·
// related까지 세어 3.0이 나오는데, 그건 스트림에 흐르지 않는 글자라 쓰면 안 된다
// (첫 실측 8/22: 예상 14,996자 vs 실제 5,589자로 막대가 59%에서 95%로 점프했다).
export function expectedOutputChars(transcriptChars: number): number {
  const chars = Math.max(1, transcriptChars);
  const tokens = 20.2 * Math.pow(chars, 0.499);
  return Math.round(tokens * 1.66);
}

// 0..∞ 비율 → 0..1. 0.8까지는 그대로, 그 뒤는 1에 점근(비율 2.0에서 ≈0.98).
export function fillCurve(ratio: number): number {
  if (!(ratio > 0)) return 0;
  if (ratio < 0.8) return ratio;
  return 0.8 + 0.2 * (1 - Math.exp(-(ratio - 0.8) * 3.2));
}

// 단계 + 진행 정보 → 0~100 정수. 구간 안에서 절대 뒤로 가지 않도록 호출부가 max를 취한다.
export function computePct(stage: CompactStage, p: { outputChars?: number; thinkingChars?: number; expectedChars?: number } = {}): number {
  if (stage === 'error') return 0;
  const [lo, hi] = STAGE_BANDS[stage];
  if (stage !== 'compact') return lo;
  const think = THINK_BAND * fillCurve((p.thinkingChars ?? 0) / THINK_SCALE);
  const outLo = lo + THINK_BAND, outHi = hi;
  const expected = Math.max(1, p.expectedChars ?? 1);
  const out = (outHi - outLo) * fillCurve((p.outputChars ?? 0) / expected);
  const pct = (p.outputChars ?? 0) > 0 ? outLo + out : lo + think;
  return Math.max(lo, Math.min(hi, Math.round(pct)));
}

// stream-json 한 줄을 해석한 결과. 진행률에 필요한 것만 남기고 나머지는 버린다.
export type StreamEvent =
  | { kind: 'text'; chars: number }        // 가시 출력(text_delta · input_json_delta)
  | { kind: 'thinking'; chars: number }    // 사고 블록 조각
  | { kind: 'result'; raw: string }        // 마지막 result 이벤트 — json 래퍼와 같은 필드
  | { kind: 'other' };

export function parseStreamLine(line: string): StreamEvent {
  const s = line.trim();
  if (!s.startsWith('{')) return { kind: 'other' };
  let j: any;
  try { j = JSON.parse(s); } catch { return { kind: 'other' }; }
  if (!j || typeof j !== 'object') return { kind: 'other' };
  if (j.type === 'result') return { kind: 'result', raw: s };
  if (j.type === 'stream_event' && j.event?.type === 'content_block_delta') {
    const d = j.event.delta ?? {};
    if (d.type === 'text_delta' && typeof d.text === 'string') return { kind: 'text', chars: d.text.length };
    if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') return { kind: 'text', chars: d.partial_json.length };
    if (d.type === 'thinking_delta' && typeof d.thinking === 'string') return { kind: 'thinking', chars: d.thinking.length };
  }
  return { kind: 'other' };
}

// 줄 단위 파서 — stdout 청크가 줄 중간에서 끊겨 와도 완성된 줄만 넘긴다.
export class LineSplitter {
  private buf = '';
  push(chunk: string, onLine: (line: string) => void) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  }
  flush(onLine: (line: string) => void) {
    if (this.buf.trim()) onLine(this.buf);
    this.buf = '';
  }
}

// ── 진행률 허브: 작업 id별 상태 + 구독자. 서버가 갱신하고 SSE 핸들러가 구독한다 ──
// 작업이 끝난 뒤에도 잠시 상태를 남겨, 구독이 완료 직후에 붙어도 마지막 상태를 받게 한다.
export class ProgressHub {
  private jobs = new Map<string, { state: ProgressState; subs: Set<(s: ProgressState) => void>; timer?: ReturnType<typeof setTimeout> }>();
  constructor(private retainMs = 60_000, private now: () => number = () => Date.now()) {}

  start(id: string): ProgressState {
    const state: ProgressState = { stage: 'prepare', pct: 0, detail: '준비', attempt: 1, outputChars: 0, thinkingChars: 0, updatedAt: this.now() };
    const prev = this.jobs.get(id);
    if (prev?.timer) clearTimeout(prev.timer);
    this.jobs.set(id, { state, subs: prev?.subs ?? new Set() });
    this.emit(id);
    return state;
  }

  get(id: string): ProgressState | null { return this.jobs.get(id)?.state ?? null; }

  // 부분 갱신. pct는 뒤로 가지 않는다 — 단, 재시도(attempt 증가)나 명시 reset은 예외.
  update(id: string, patch: Partial<ProgressState>, opts: { allowBackward?: boolean } = {}) {
    const j = this.jobs.get(id);
    if (!j) return;
    const next: ProgressState = { ...j.state, ...patch, updatedAt: this.now() };
    if (!opts.allowBackward && patch.pct != null && patch.pct < j.state.pct && next.stage !== 'error') next.pct = j.state.pct;
    j.state = next;
    this.emit(id);
    if (next.stage === 'done' || next.stage === 'error') {
      if (j.timer) clearTimeout(j.timer);
      j.timer = setTimeout(() => this.jobs.delete(id), this.retainMs);
      if (typeof (j.timer as any)?.unref === 'function') (j.timer as any).unref();
    }
  }

  subscribe(id: string, fn: (s: ProgressState) => void): () => void {
    let j = this.jobs.get(id);
    if (!j) {
      // 아직 시작 전이면 빈 자리를 만들어 둔다 — POST보다 SSE가 먼저 붙는 경우
      j = { state: { stage: 'prepare', pct: 0, detail: '대기', attempt: 1, outputChars: 0, thinkingChars: 0, updatedAt: this.now() }, subs: new Set() };
      this.jobs.set(id, j);
    }
    j.subs.add(fn);
    fn(j.state);
    return () => { j!.subs.delete(fn); };
  }

  private emit(id: string) {
    const j = this.jobs.get(id);
    if (!j) return;
    for (const fn of j.subs) { try { fn(j.state); } catch {} }
  }
}

// 작업 id 위생 — 클라이언트가 만든 값이라 형식을 고정한다.
export function isValidProgressId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}
