// 압축 진행률 순수 로직 테스트 — stream-json 줄 해석, 예상 출력 길이, % 산정, 허브의
// 단조 증가·재시도 예외를 고정한다. 서버 기동 없이 dist/progress.js만 require한다.
// 줄 형식 픽스처는 8/22 실측(claude -p --output-format stream-json --verbose
// --include-partial-messages, --json-schema 유무 두 경우)에서 그대로 가져왔다.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseStreamLine, LineSplitter, expectedOutputChars, fillCurve, computePct, ProgressHub, isValidProgressId, STAGE_BANDS } = require('../dist/progress.js');

test('parseStreamLine: text_delta·input_json_delta는 가시 출력, thinking_delta는 사고, result는 원문 보존', () => {
  const text = '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"1, 2, 3"}},"session_id":"x","uuid":"y"}';
  const json = '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"nums\\": [1, 2,"}},"session_id":"x","uuid":"y"}';
  const think = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"사용자가","estimated_tokens":null}},"session_id":"x"}';
  const sig = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqYE"}},"session_id":"x"}';
  const result = '{"is_error":false,"duration_api_ms":2908,"num_turns":1,"total_cost_usd":0.0071659,"usage":{"input_tokens":10,"output_tokens":270},"result":"{\\"nums\\":[1]}","type":"result","duration_ms":3023}';
  assert.deepStrictEqual(parseStreamLine(text), { kind: 'text', chars: 7 });
  assert.deepStrictEqual(parseStreamLine(json), { kind: 'text', chars: '{"nums": [1, 2,'.length });
  assert.deepStrictEqual(parseStreamLine(think), { kind: 'thinking', chars: 4 });
  assert.deepStrictEqual(parseStreamLine(sig), { kind: 'other' });
  const r = parseStreamLine(result);
  assert.strictEqual(r.kind, 'result');
  // result 줄은 json 래퍼와 같은 필드를 실으므로 기존 계측 파싱이 그대로 탈 수 있어야 한다
  const w = JSON.parse(r.raw);
  assert.strictEqual(w.result, '{"nums":[1]}');
  assert.strictEqual(w.total_cost_usd, 0.0071659);
  assert.strictEqual(w.usage.output_tokens, 270);
});

test('parseStreamLine: JSON이 아닌 줄(stderr 섞임·훅 안내문)은 other', () => {
  assert.deepStrictEqual(parseStreamLine('Client.listTools() called but server does not advertise tools capability'), { kind: 'other' });
  assert.deepStrictEqual(parseStreamLine(''), { kind: 'other' });
  assert.deepStrictEqual(parseStreamLine('{"type":"system","subtype":"init"}'), { kind: 'other' });
  assert.deepStrictEqual(parseStreamLine('{broken'), { kind: 'other' });
});

test('LineSplitter: 청크가 줄 중간에서 끊겨도 완성된 줄만 넘기고 flush로 꼬리를 비운다', () => {
  const s = new LineSplitter(), got = [];
  s.push('{"a":1}\n{"b"', l => got.push(l));
  assert.deepStrictEqual(got, ['{"a":1}']);
  s.push(':2}\n\n{"c":3}', l => got.push(l));
  assert.deepStrictEqual(got, ['{"a":1}', '{"b":2}']);
  s.flush(l => got.push(l));
  assert.deepStrictEqual(got, ['{"a":1}', '{"b":2}', '{"c":3}']);
  s.flush(l => got.push(l)); // 비어 있으면 아무것도 안 함
  assert.strictEqual(got.length, 3);
});

test('expectedOutputChars: 원문이 클수록 커지되 제곱근 꼴로 완만하다', () => {
  const a = expectedOutputChars(5_000), b = expectedOutputChars(20_000), c = expectedOutputChars(80_000);
  assert.ok(a > 0 && b > a && c > b);
  assert.ok(b / a > 1.8 && b / a < 2.2, `4배 원문 → 약 2배: ${b / a}`);
  assert.ok(c / b > 1.8 && c / b < 2.2);
  assert.ok(expectedOutputChars(0) > 0); // 0·음수 입력도 안전
});

test('fillCurve: 0.8까지 선형, 그 뒤 1에 점근하며 절대 1을 넘지 않는다', () => {
  assert.strictEqual(fillCurve(0), 0);
  assert.strictEqual(fillCurve(0.5), 0.5);
  assert.ok(fillCurve(1.0) > 0.8 && fillCurve(1.0) < 1);
  assert.ok(fillCurve(3.0) > fillCurve(2.0) && fillCurve(3.0) < 1);
  assert.strictEqual(fillCurve(NaN), 0);
});

test('computePct: 단계 하한에서 시작하고, 본 압축 안에서는 사고→출력 순으로 차며 상한을 넘지 않는다', () => {
  assert.strictEqual(computePct('prepare'), STAGE_BANDS.prepare[0]);
  assert.strictEqual(computePct('glossary'), STAGE_BANDS.glossary[0]);
  assert.strictEqual(computePct('assemble'), STAGE_BANDS.assemble[0]);
  assert.strictEqual(computePct('done'), 100);
  assert.strictEqual(computePct('error'), 0);
  const [lo, hi] = STAGE_BANDS.compact;
  assert.strictEqual(computePct('compact'), lo);
  // 사고만 길어져도 출력 구간으로 넘어가지 않는다(38 이하)
  const thinkOnly = computePct('compact', { thinkingChars: 100_000, expectedChars: 10_000 });
  assert.ok(thinkOnly > lo && thinkOnly <= lo + 8, String(thinkOnly));
  // 출력이 시작되면 사고 구간을 건너뛰고 출력 구간에서 비례로 찬다
  const half = computePct('compact', { outputChars: 5_000, expectedChars: 10_000 });
  const full = computePct('compact', { outputChars: 10_000, expectedChars: 10_000 });
  const over = computePct('compact', { outputChars: 40_000, expectedChars: 10_000 });
  assert.ok(half > lo + 8 && half < full && full < over && over <= hi, `${half} ${full} ${over}`);
});

test('ProgressHub: 갱신은 뒤로 가지 않되 재시도(allowBackward)는 예외, 완료·실패 후 구독자에게 마지막 상태가 간다', () => {
  let now = 1000;
  const hub = new ProgressHub(60_000, () => now);
  const seen = [];
  const unsub = hub.subscribe('job1', s => seen.push({ stage: s.stage, pct: s.pct }));
  assert.deepStrictEqual(seen.at(-1), { stage: 'prepare', pct: 0 }); // 시작 전 구독 → 대기 상태 즉시 수신
  hub.start('job1');
  hub.update('job1', { stage: 'compact', pct: 60 });
  hub.update('job1', { stage: 'compact', pct: 55 });          // 뒤로 가는 갱신은 막힌다
  assert.strictEqual(hub.get('job1').pct, 60);
  hub.update('job1', { stage: 'compact', pct: 30, attempt: 2 }, { allowBackward: true });
  assert.strictEqual(hub.get('job1').pct, 30);
  assert.strictEqual(hub.get('job1').attempt, 2);
  hub.update('job1', { stage: 'error', pct: 0, detail: 'x' }, { allowBackward: true });
  assert.strictEqual(hub.get('job1').stage, 'error');
  assert.strictEqual(seen.at(-1).stage, 'error');
  unsub();
  // 완료 뒤에 붙는 구독도 보존된 마지막 상태를 받는다(지연 구독 대비)
  const late = [];
  hub.subscribe('job1', s => late.push(s.stage));
  assert.deepStrictEqual(late, ['error']);
  hub.update('job1', { stage: 'done', pct: 100 }); // 종료 타이머 정리용
});

test('ProgressHub: 모르는 id의 update는 무시한다', () => {
  const hub = new ProgressHub(1);
  hub.update('nope', { pct: 50 });
  assert.strictEqual(hub.get('nope'), null);
});

test('isValidProgressId: 클라이언트가 만든 16진 24자는 통과, 경로·공백·짧은 값은 거부', () => {
  assert.ok(isValidProgressId('0123456789abcdef01234567'));
  assert.ok(!isValidProgressId('short'));
  assert.ok(!isValidProgressId('../etc/passwd'));
  assert.ok(!isValidProgressId('a b c d e f g h'));
  assert.ok(!isValidProgressId(null));
  assert.ok(!isValidProgressId(12345678));
});
