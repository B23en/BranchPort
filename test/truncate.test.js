// 압축 패키지 승계 절단 회귀 테스트 — 앵커 섹션이 살아남는지 고정한다.
// 실측 배경: 19,444자 패키지에서 "## 원문 앵커"가 18,754자 위치라 14,000자 앞자르기에
// 통째로 잘렸다. 앵커는 갈래 AI가 /expand로 원문을 파낼 유일한 경로다.
const { test } = require('node:test');
const assert = require('node:assert');
const { truncatePackage } = require('../dist/transcript.js');

const mk = (headLen, anchorLen) =>
  '## 요약\n' + 'a'.repeat(headLen) + '\n## 원문 앵커 (부족하면 펼치기)\n' + 'b'.repeat(anchorLen);

test('상한 이하면 원본 그대로', () => {
  const md = mk(100, 100);
  assert.equal(truncatePackage(md, 14000), md);
});

test('상한 초과여도 앵커 섹션은 반드시 살아남는다', () => {
  const md = mk(20000, 500);
  const out = truncatePackage(md, 14000);
  assert.ok(out.length <= 14000, '상한을 넘지 않는다');
  assert.ok(out.includes('## 원문 앵커'), '앵커 헤더가 남아야 한다');
  assert.ok(out.includes('b'.repeat(500)), '앵커 본문이 온전히 남아야 한다');
  assert.ok(out.includes('## 요약'), '요약층 앞부분도 남아야 한다');
});

test('앵커가 과도하게 길면 잘리되 잘렸다고 표시한다', () => {
  const out = truncatePackage(mk(20000, 9000), 14000);
  assert.ok(out.length <= 14000);
  assert.ok(out.includes('## 원문 앵커'));
  assert.ok(out.includes('앵커 목록 일부 생략'), '절단 사실을 표시해야 한다');
});

// parseSummary는 LLM 자유 서술의 개행을 지우지 않으므로, 요약이 이 섹션명을 줄머리에
// 인용하면 앞에서 찾는 방식은 그걸 앵커로 오인해 진짜 앵커 목록을 통째로 버린다.
test('요약이 앵커 헤더를 줄머리에 인용해도 진짜(마지막) 앵커를 고른다', () => {
  const md = '## 요약\n앞자르기 주의:\n## 원문 앵커 가 md 끝에 있어 먼저 잘린다\n'
    + 'a'.repeat(20000)
    + '\n## 원문 앵커 (부족하면 펼치기)\n- 12:00:00 · `real-anchor-id` — 진짜 앵커\n';
  const out = truncatePackage(md, 14000);
  assert.ok(out.length <= 14000);
  assert.ok(out.includes('real-anchor-id'), '진짜 앵커 항목이 남아야 한다');
});

test('앵커 섹션이 없는 옛 패키지는 종전대로 앞자르기', () => {
  const md = '## 요약\n' + 'a'.repeat(20000);
  const out = truncatePackage(md, 14000);
  assert.equal(out.length, 14000);
});
