// 검색 점수화 회귀 테스트 — searchIndex는 결정론 순수 함수라 이 레포에서 테스트 비용이
// 가장 싸다. 실측(2026-08-10, docs/2026-08-09-확장기능-실현성-분석-화수.md §10)에서
// 확정된 성질들을 고정한다: IDF 감쇠 · 다중 키워드 부스트 · 허브 가드 · 그래프 회수.
// 실행: npm test  (빌드 선행: npm run build)
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSearchIndex, searchIndex, relatedToRange } = require('../dist/search.js');

let seq = 0;
function turn(over = {}) {
  const id = over.id ?? 't' + (++seq);
  const ts = over.ts ?? `2026-08-01T10:${String(seq).padStart(2, '0')}:00Z`;
  return {
    id, hash: 'h' + id, phase: 'chat',
    prompt: '', answer: '', headline: '',
    timestamp: ts, endTimestamp: ts,
    sessionId: 's1', isForkRoot: false, forkName: null,
    tools: [], toolCount: 0, delegated: false,
    hasError: false, hasImage: false, interrupted: false,
    files: [], outputTokens: 0, gapMin: null, compactBefore: false, children: [],
    ...over,
  };
}
const labelsOf = (m) => Object.fromEntries(Object.entries(m).map(([id, l]) => ['h' + id, l]));

test('직접 매치가 상위에 온다 (라벨 제목·요약)', () => {
  const turns = [
    turn({ id: 'a' }), turn({ id: 'b' }), turn({ id: 'c' }),
  ];
  const idx = buildSearchIndex(turns, labelsOf({
    a: { t: '팔레트 교정', g: '색각 검증 통과 3색으로 교체' },
    b: { t: '무관한 작업', g: '다른 일' },
    c: { t: '또 무관', g: '또 다른 일' },
  }));
  const hits = searchIndex(idx, '팔레트');
  assert.equal(hits[0].id, 'a');
  assert.equal(hits[0].via, 'direct');
});

test('IDF: 흔한 단어보다 희귀 단어 매치가 높은 점수', () => {
  // "검증"은 10턴 전부에, "스플라이스"는 1턴에만 등장
  const turns = [];
  const lab = {};
  for (let i = 0; i < 10; i++) {
    const id = 'n' + i;
    turns.push(turn({ id }));
    lab[id] = { t: `검증 작업 ${i}`, g: '검증했다' };
  }
  lab['n7'] = { t: '스플라이스 검증', g: '포크 스플라이스를 검증했다' };
  const idx = buildSearchIndex(turns, labelsOf(lab));
  const common = searchIndex(idx, '검증')[0].score;
  const rare = searchIndex(idx, '스플라이스')[0].score;
  assert.ok(rare > common, `희귀(${rare}) > 흔함(${common})이어야 한다`);
});

test('다중 키워드 동시 매치 부스트', () => {
  const turns = [turn({ id: 'x' }), turn({ id: 'y' })];
  const idx = buildSearchIndex(turns, labelsOf({
    x: { t: '큐 복원', g: '끼어든 질문을 복원했다' },
    y: { t: '큐 조사', g: '다른 조사' },
  }));
  const hits = searchIndex(idx, '큐 복원');
  assert.equal(hits[0].id, 'x'); // 두 키워드 다 맞은 쪽이 위
  assert.ok(hits[0].score > hits[1].score);
});

test('그래프 회수: 키워드 없는 턴이 파일 공유로 딸려온다', () => {
  // 검수 지적 반영: n이 작으면 허브 가드(30%)가 파일 확산 자체를 막아 세션 인접으로만
  // 회수된다 — n≥7 + seed·peer를 다른 세션에 둬서 "파일 공유" 경로만 남긴다
  const turns = [
    turn({ id: 'seed', files: ['tree.ts'], session: 'sA' }),
    turn({ id: 'peer', files: ['tree.ts'], session: 'sB' }),
    turn({ id: 'far', files: ['other.ts'], session: 'sB' }),
  ];
  for (let i = 0; i < 7; i++) turns.push(turn({ id: 'pad' + i, session: 'sC' }));
  const idx = buildSearchIndex(turns, labelsOf({
    seed: { t: '접합 수정', g: '포크 접합을 고침' },
    peer: { t: '코드 검토', g: '변경분 검토' },
    far: { t: '딴 일', g: '무관' },
  }));
  const hits = searchIndex(idx, '접합');
  const peer = hits.find(h => h.id === 'peer');
  assert.ok(peer, 'tree.ts 공유 턴이 회수돼야 한다');
  assert.equal(peer.via, 'graph');
  assert.ok(!hits.find(h => h.id === 'far'), '파일 비공유·비인접 턴은 회수되면 안 된다');
});

test('허브 가드: 전체 30% 초과가 만진 파일로는 확산하지 않는다', () => {
  const turns = [];
  const lab = {};
  for (let i = 0; i < 10; i++) {
    const id = 'm' + i;
    turns.push(turn({ id, files: ['index.html'] })); // 전원이 만진 허브 파일
    lab[id] = { t: i === 0 ? '유일 시드' : `작업 ${i}`, g: '...' };
  }
  const idx = buildSearchIndex(turns, labelsOf(lab));
  const hits = searchIndex(idx, '유일');
  // 시드 1개 + 인접(앞뒤) 최대 2개까지만 — 허브 파일 확산이 막혀 전원 회수되지 않아야 한다
  assert.ok(hits.length <= 3, `허브 확산 차단 실패: ${hits.length}개 회수됨`);
});

test('확산 기여 상한: 허브성 턴의 이웃이 직접매치 턴보다 위로 못 온다', () => {
  // 8/12 리뷰 실측 회귀 패턴 재현: 흔한 파일 하나를 공유하는 허브 턴(hub)이 다중
  // 키워드 매치로 큰 직접점수를 받으면, 그 이웃(hubneighbor)은 확산만으로 hub의
  // 정규화 안 된 원점수를 거의 그대로 받아 direct(진짜 키워드 매치 턴)를 밀어냈다.
  // 세션·인접을 서로 분리해 파일 확산만 순수하게 걸리도록 구성한다.
  const hubTokens = Array.from({ length: 23 }, (_, i) => `허브키워드${i}`);
  const fileTokens = Array.from({ length: 5 }, (_, i) => `직접파일${i}`);

  const turns = [
    turn({ id: 'hub', sessionId: 'sHub', files: ['hub.ts'] }),
    turn({ id: 'hubneighbor', sessionId: 'sNeighbor', files: ['hub.ts'] }),
    turn({ id: 'direct', sessionId: 'sDirect', files: fileTokens.map(t => `${t}.ts`) }),
  ];
  for (let i = 0; i < 7; i++) turns.push(turn({ id: 'pad' + i, sessionId: 'sPad' + i }));

  const idx = buildSearchIndex(turns, labelsOf({
    hub: { t: hubTokens.join(' '), g: '허브성 대형 턴' },
  }));

  const hits = searchIndex(idx, [...hubTokens, ...fileTokens].join(' '), 20);
  const direct = hits.find(h => h.id === 'direct');
  const neighbor = hits.find(h => h.id === 'hubneighbor');

  assert.ok(direct, '직접 키워드 매치 턴은 회수돼야 한다');
  assert.equal(direct.via, 'direct');
  assert.ok(neighbor, '허브 이웃도 확산으로는 회수돼야 한다 (확산 자체가 죽으면 안 됨)');
  assert.equal(neighbor.via, 'graph');
  assert.ok(direct.score > neighbor.score,
    `허브 이웃(${neighbor.score})이 직접매치(${direct.score})보다 위로 올라오면 안 된다`);
});

test('n 상한 준수 · 1글자 키워드는 무시된다', () => {
  const turns = [turn({ id: 'p' }), turn({ id: 'q' })];
  const idx = buildSearchIndex(turns, labelsOf({
    p: { t: '검색 구현', g: '...' }, q: { t: '검색 문서', g: '...' },
  }));
  assert.equal(searchIndex(idx, '검색', 1).length, 1);       // topN 상한
  assert.ok(searchIndex(idx, '검색', 50).length >= 2);
  assert.equal(searchIndex(idx, '한').length, 0);            // 1글자 키워드 필터 (설계 성질)
});

test('relatedToRange: 범위 자신은 제외하고 연결 턴만 회수', () => {
  const turns = [
    turn({ id: 'r1', files: ['server.ts'] }),
    turn({ id: 'r2', files: ['server.ts'] }),
    turn({ id: 'out', files: ['server.ts'] }),
    turn({ id: 'none', files: ['zzz.ts'] }),
  ];
  const idx = buildSearchIndex(turns, {});
  const hits = relatedToRange(idx, new Set(['r1', 'r2']), 5);
  assert.ok(hits.find(h => h.id === 'out'), '범위 밖 연결 턴이 회수돼야 한다');
  assert.ok(!hits.find(h => h.id === 'r1') && !hits.find(h => h.id === 'r2'), '범위 자신은 제외');
});
