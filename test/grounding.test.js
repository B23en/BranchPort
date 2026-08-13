// groundingCheck 회귀 테스트 — 순수 함수라 서버 기동 없이 테스트한다.
// 실행: npm test  (빌드 선행: npm run build)
// 고정하는 성질(2026-08-13 스킬 라운드에서 확정):
//  1. 수치는 단어 경계로 대조하되, 하이픈으로 이어진 날짜("2026-08-12")의 부분 문자열로는
//     오매치되지 않는다 — \b만으로는 "-"가 비단어 문자라 경계가 생겨 "12"가 오탐한다.
//  2. tool result(에러 문구가 사는 곳)가 대조 소스에 편입돼야 한다 — 빠지면 gotcha 대조가
//     항상 "0/N 확인"으로 오탐한다.
//  3. 식별자·수치가 아예 없는 순한글 문장은 total===0으로 "대조 불가"와 "대조 실패"를 구분한다.
const { test } = require('node:test');
const assert = require('node:assert');
const { groundingCheck } = require('../dist/grounding.js');

function turn(over = {}) {
  return {
    id: 't1', hash: 'h1', phase: 'chat',
    prompt: '', answer: '', headline: '',
    timestamp: '2026-08-13T10:00:00Z', endTimestamp: '2026-08-13T10:00:00Z',
    sessionId: 's1', isForkRoot: false, forkName: null,
    tools: [], toolCount: 0, delegated: false,
    hasError: false, hasImage: false, interrupted: false,
    files: [], outputTokens: 0, gapMin: null, compactBefore: false, children: [],
    ...over,
  };
}

test('수치는 단어 경계로 대조 — "12"가 날짜 "2026-08-12"에 오매치되지 않는다', () => {
  const t = turn({ prompt: '작업일은 2026-08-12로 확정했다', answer: '' });
  const r = groundingCheck('설정값 12를 확인했다', t);
  assert.equal(r.total, 1); // "12" 하나만 수치 토큰으로 잡힘
  assert.equal(r.found, 0); // 날짜 안의 "12"는 진짜 등장이 아니므로 미확인
});

test('영문자에 붙은 수치는 오매치되지 않는다 — "12"가 "v12"·"sha256"의 부분으로 잡히면 안 된다', () => {
  const t = turn({ prompt: 'v12로 올리고 sha256 해시를 썼다', answer: '' });
  const r = groundingCheck('설정값 12를 확인했다 코드 256개', t);
  assert.equal(r.total, 2); // "12", "256"
  assert.equal(r.found, 0); // v12·sha256의 부분 문자열은 진짜 등장이 아니다
});

test('한글에 붙은 수치는 정상 대조된다 — "포트4300"', () => {
  const t = turn({ prompt: '포트4300에서 서버가 돈다', answer: '' });
  const r = groundingCheck('포트 4300 확인', t);
  assert.equal(r.found >= 1, true); // \w는 한글 미포함 — 한글 인접은 경계로 취급
});

test('진짜 독립된 수치는 정상적으로 대조 통과한다', () => {
  const t = turn({ prompt: '설정값 12를 확인했다', answer: '' });
  const r = groundingCheck('설정값 12를 확인했다', t);
  assert.equal(r.total, 1);
  assert.equal(r.found, 1);
});

test('긴 수치에 포함된 짧은 수치는 대조되지 않는다 (부분 문자열 오탐 방지)', () => {
  const t = turn({ prompt: '값은 123이다', answer: '' });
  const r = groundingCheck('12를 봤다', t);
  assert.equal(r.total, 1);
  assert.equal(r.found, 0); // "123" 안의 "12"는 오매치 금지
});

test('tool result 편입 — 에러 문구가 tool result에만 있어도 원문 대조를 통과한다', () => {
  const t = turn({
    prompt: '빌드가 왜 실패하는지 알아봐줘', answer: '로그를 확인했다',
    tools: [{
      toolUseId: 'tu1', name: 'Bash', category: 'exec',
      inputPreview: 'npm run build', filePath: null, resultPreview: null, isError: true,
    }],
  });
  const toolResults = new Map([['tu1', 'Error: ECONNREFUSED — 접속이 거부되었다']]);
  const r = groundingCheck('원인은 ECONNREFUSED 에러였다', t, toolResults);
  assert.equal(r.total, 1);
  assert.equal(r.found, 1, 'tool result 전문이 편입되면 에러 식별자가 대조돼야 한다');
});

test('tool result 없이는 같은 문구가 확인되지 않는다 (편입 안 됐을 때의 회귀 방지)', () => {
  const t = turn({
    prompt: '빌드가 왜 실패하는지 알아봐줘', answer: '로그를 확인했다',
    tools: [{
      toolUseId: 'tu1', name: 'Bash', category: 'exec',
      inputPreview: 'npm run build', filePath: null, resultPreview: null, isError: true,
    }],
  });
  const r = groundingCheck('원인은 ECONNREFUSED 에러였다', t); // toolResults 생략
  assert.equal(r.found, 0);
});

test('resultPreview로도 대조된다 (toolResults 맵에 없는 경우의 폴백)', () => {
  const t = turn({
    prompt: '', answer: '',
    tools: [{
      toolUseId: 'tu2', name: 'Bash', category: 'exec',
      inputPreview: '', filePath: null, resultPreview: 'ENOENT 파일 없음', isError: true,
    }],
  });
  const r = groundingCheck('ENOENT 에러가 났다', t); // toolResults 없음 → resultPreview 폴백
  assert.equal(r.found, 1);
});

test('식별자·수치가 없는 순한글 문장은 total 0, found 0 (대조 불가 ≠ 대조 실패)', () => {
  const t = turn({ prompt: '테스트', answer: '테스트' });
  const r = groundingCheck('이것은 순수 한글 문장이라 대조할 게 없다', t);
  assert.deepEqual(r, { found: 0, total: 0 });
});

test('CamelCase·snake_case 식별자도 대조된다', () => {
  const t = turn({ prompt: '', answer: 'handleSkillExport와 tool_result_map을 고쳤다' });
  const r = groundingCheck('handleSkillExport와 tool_result_map 수정', t);
  assert.equal(r.total, 2);
  assert.equal(r.found, 2);
});
