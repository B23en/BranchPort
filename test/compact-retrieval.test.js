// 압축 갈래 리트리버 시점 격리 회귀 테스트 — 후보 필터가 anchors 최대 ts 이후 턴과
// 범위(anchors) 안 턴을 배제하는 성질을 고정한다. 순수 로직만 다루므로 서버 기동 없이
// dist/compact-retrieval.js만 require한다(server.ts는 require 시 listen()을 부른다).
const { test } = require('node:test');
const assert = require('node:assert');
const { compactRetrievalCandidates } = require('../dist/compact-retrieval.js');

const long = (s) => s + 'x'.repeat(500); // 400자 길이 컷을 넘기기 위한 헬퍼

function turn(id, ts, prompt = long('p'), answer = long('a')) {
  return { id, timestamp: ts, prompt, answer };
}

test('anchors가 비어 있으면(옛 패키지) 후보도 비어 리트리버가 생략된다', () => {
  const turns = [turn('t1', '2026-08-01T00:00:00Z')];
  const out = compactRetrievalCandidates([], turns);
  assert.equal(out.size, 0);
});

test('anchors 최대 ts 이전이면서 범위 밖인 턴만 후보로 남는다', () => {
  const anchors = [
    { id: 'a1', ts: '2026-08-10T00:00:00Z' },
    { id: 'a2', ts: '2026-08-12T00:00:00Z' }, // 최대 ts
  ];
  const turns = [
    turn('before', '2026-08-05T00:00:00Z'), // 범위 이전 — 후보
    turn('a1', '2026-08-10T00:00:00Z'),      // 범위 안(anchor) — 제외
    turn('a2', '2026-08-12T00:00:00Z'),      // 범위 안(anchor) — 제외
    turn('after', '2026-08-15T00:00:00Z'),   // 범위 이후 — 시점 격리 위반이라 제외
  ];
  const out = compactRetrievalCandidates(anchors, turns);
  assert.deepEqual([...out], ['before']);
});

test('anchors 최대 ts와 정확히 같은 타임스탬프의 범위 밖 턴은 포함된다(이하 기준)', () => {
  const anchors = [{ id: 'a1', ts: '2026-08-12T00:00:00Z' }];
  const turns = [turn('same-ts', '2026-08-12T00:00:00Z')]; // anchor는 아니지만 ts는 같음
  const out = compactRetrievalCandidates(anchors, turns);
  assert.deepEqual([...out], ['same-ts']);
});

test('anchors ts 이후 턴은 제외된다(범위 안 여부와 무관)', () => {
  const anchors = [{ id: 'a1', ts: '2026-08-12T00:00:00Z' }];
  const turns = [turn('future', '2026-08-12T00:00:01Z')];
  const out = compactRetrievalCandidates(anchors, turns);
  assert.equal(out.size, 0);
});

test('"(계속)" 프롬프트와 400자 이하 짧은 턴은 후보에서 빠진다(노드 갈래 조상 필터와 동일 기준)', () => {
  const anchors = [{ id: 'a1', ts: '2026-08-12T00:00:00Z' }];
  const turns = [
    turn('continued', '2026-08-01T00:00:00Z', '(계속)', long('a')),
    turn('short', '2026-08-01T00:00:00Z', 'p', 'a'), // 합쳐서 400자 이하
    turn('ok', '2026-08-01T00:00:00Z'),
  ];
  const out = compactRetrievalCandidates(anchors, turns);
  assert.deepEqual([...out], ['ok']);
});

test('anchors에 ts가 전혀 없으면(판정 불가) 후보를 비워 안전 측으로 생략한다', () => {
  const anchors = [{ id: 'a1', ts: null }, { id: 'a2', ts: '' }];
  const turns = [turn('t1', '2026-08-01T00:00:00Z')];
  const out = compactRetrievalCandidates(anchors, turns);
  assert.equal(out.size, 0);
});

test('timestamp가 없는 턴은 후보에서 제외된다', () => {
  const anchors = [{ id: 'a1', ts: '2026-08-12T00:00:00Z' }];
  const turns = [turn('no-ts', null)];
  const out = compactRetrievalCandidates(anchors, turns);
  assert.equal(out.size, 0);
});
