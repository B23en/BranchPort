// renderTranscript 적응형 절단 회귀 테스트 — 순수 함수라 서버 기동 없이 테스트한다.
// 실행: npm test  (빌드 선행: npm run build)
// 고정하는 성질(2026-08-15 적응형 절단 도입 시 확정):
//  1. 에러·검증 출력은 앞+뒤를 남기고 가운데를 잘라, 출력 끝의 요약·실패 줄이 살아남는다.
//     내용 조회(Read)는 앞만 남긴다. 절단 표기는 "…(truncated …)" 형태를 유지한다.
//  2. 예산 초과 시 내용 조회·확인 응답부터 줄이고 에러는 마지막까지 지킨다.
//  3. 최종 단계로도 초과하면 오래된 턴을 통째로 떨어뜨리되 남은 턴의 "TURN i/N" 번호는
//     원래 인덱스를 유지한다(앵커·evidence 체계가 TURN N을 참조).
//  4. 예산이 남으면 에러 결과는 기본 캡(1500)을 넘어 복원된다.
const { test } = require('node:test');
const assert = require('node:assert');
const { renderTranscript } = require('../dist/transcript.js');

let seq = 0;
function tool(name, result, over = {}) {
  const id = 'tu' + (++seq);
  return { toolUseId: id, name, category: 'exec', inputPreview: name + ' input', filePath: null, resultPreview: null, isError: false, ...over, _result: result };
}
function node(id, type, text, tools = []) {
  return { id, type, preview: '', text, tools, children: [], isForkRoot: false, interrupted: false };
}
// 턴 하나 = Q 노드 → A 노드(도구 포함). 결과 원문은 toolResults 맵에 넣는다.
function fixture(turnsSpec) {
  const roots = [], range = [], toolResults = new Map();
  turnsSpec.forEach((spec, i) => {
    const q = node(`q${i}`, 'Q', spec.prompt ?? `질문 ${i + 1}`);
    const tools = spec.tools ?? [];
    for (const t of tools) { toolResults.set(t.toolUseId, t._result); delete t._result; }
    const a = node(`a${i}`, 'A', spec.answer ?? `답변 ${i + 1}`, tools);
    q.children.push(a);
    roots.push(q);
    range.push({ id: q.id, timestamp: `2026-08-15T00:0${i}:00Z`, isForkRoot: false });
  });
  return { roots, range, toolResults };
}
const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join('\n');

test('에러·검증 출력은 앞+뒤 보존, Read는 앞만', () => {
  const bashOut = lines('log', 200) + '\nFAILED: 3 tests, 2 errors';
  const readOut = lines('src', 200);
  const { roots, range, toolResults } = fixture([
    { tools: [tool('Bash', bashOut), tool('Read', readOut)] },
  ]);
  const out = renderTranscript(range, roots, toolResults);
  assert.match(out, /FAILED: 3 tests, 2 errors/, '검증 출력의 마지막 줄(요약)이 살아남아야 한다');
  assert.match(out, /log line 1\n/, '검증 출력의 앞부분도 남아야 한다');
  assert.match(out, /…\(truncated \d+ chars in the middle\)…/, '가운데 절단 표기');
  assert.match(out, /src line 1\n/);
  assert.doesNotMatch(out, /src line 200/, 'Read는 뒷부분을 남기지 않는다');
  assert.match(out, /…\(truncated \d+→300 chars\)/, 'Read 절단 표기는 기존 형태 유지');
});

test('예산 초과 시 내용 조회부터 줄이고 에러는 지킨다', () => {
  const err = lines('ERR', 60);          // ~700자 — TIGHT.error(800) 이하라 어느 단계에서도 전문
  const read = lines('content', 400);    // ~6,000자
  const { roots, range, toolResults } = fixture([
    { tools: [tool('Bash', err, { isError: true }), tool('Read', read)] },
    { tools: [tool('Read', read)] },
  ]);
  // 예산을 "기본 캡 결과보다 조금 작게" 잡아 1단(내용 조회 감축)이 발동하게 한다.
  const base = renderTranscript(range, roots, toolResults);
  const out = renderTranscript(range, roots, toolResults, base.length - 50);
  assert.ok(out.length <= base.length - 50);
  assert.match(out, /ERR line 60/, '에러 결과는 전문 유지');
  assert.match(out, /…\(truncated \d+→150 chars\)/, 'Read가 TIGHT 캡(150)으로 줄어든다');
});

test('최종 단계로도 초과하면 오래된 턴을 통째로 떨어뜨리고 TURN 번호를 유지한다', () => {
  const big = lines('x', 300);
  const { roots, range, toolResults } = fixture([
    { prompt: '첫 질문', tools: [tool('Bash', big)] },
    { prompt: '둘째 질문', tools: [tool('Bash', big)] },
    { prompt: '셋째 질문', tools: [tool('Bash', big)] },
  ]);
  // 최종 단계(TIGHT, evidence 400)로 렌더한 한 턴이 ~500자. 700자 예산이면 사다리를 다
  // 내려가도 3턴(~1,500자)이 안 들어가므로 셋째 턴만 남고 1·2는 통째로 빠져야 한다.
  const out = renderTranscript(range, roots, toolResults, 700);
  assert.ok(out.length <= 700);
  assert.match(out, /^\[NOTE\] transcript exceeds budget — TURN 1–2\/3 omitted entirely; the range below starts at TURN 3/);
  assert.match(out, /===== TURN 3\/3 /, '남은 턴은 원래 번호(3/3)를 유지');
  assert.doesNotMatch(out, /첫 질문|둘째 질문/);
  assert.match(out, /셋째 질문/);
  assert.doesNotMatch(out, /===== TURN 1\/3|===== TURN 2\/3/, '빠진 턴의 헤더 파편이 남지 않는다');
});

test('예산이 남으면 에러 결과는 기본 캡을 넘어 복원된다', () => {
  const err = lines('E', 350);           // ~3,000자 > CAPS.error(1500), < ERROR_RELIEF(4000)
  const { roots, range, toolResults } = fixture([{ tools: [tool('Bash', err, { isError: true })] }]);
  const out = renderTranscript(range, roots, toolResults);
  assert.match(out, /E line 350/);
  assert.doesNotMatch(out, /truncated/, '예산이 넉넉하면 에러는 전문');
  // 예산이 빠듯하면(복원본은 안 들어가고 기본본은 들어가는 크기) 기본 캡으로 돌아간다.
  const tightBudget = out.length - 10;
  const out2 = renderTranscript(range, roots, toolResults, tightBudget);
  assert.ok(out2.length <= tightBudget);
  assert.match(out2, /truncated/, '복원본이 예산을 넘으면 캡 적용본을 쓴다');
});
