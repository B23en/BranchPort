// 공유메모리(용어부록 캐시) 회귀 테스트 — 순수 함수 + fs 왕복만 다룬다.
// server.ts는 require 시 즉시 server.listen()을 호출하므로(가드 없음) 여기서 절대
// require하지 않는다 — glossary.ts만 require해 서버 기동 없이 테스트한다.
// 설계 배경: docs 아키텍처 검토(8/17) — 압축 1회 비용의 절반이 용어부록(LLM 2회 중
// 1회)이고, 실측 재사용률 42.7%(고유 용어 67/117) — 정의를 캐시해 히트는 LLM 없이
// 재사용하고 미스만 생성한다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  glossaryCacheKey, snippetFingerprint, splitGlossaryCache, mergeGlossaryCache,
  loadGlossaryCache, saveGlossaryCache,
} = require('../dist/glossary.js');

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-glossary-')), name);
}

function evidence(term, turnId, snippet, ts = '2026-08-04T10:00:00Z') {
  return { term, turnId, ts, snippet };
}

// ── 키 조합 ────────────────────────────────────────────────────────────
test('glossaryCacheKey — 용어와 정의턴id를 "|"로 결합한다', () => {
  assert.equal(glossaryCacheKey('BranchPort', 'turn-1'), 'BranchPort|turn-1');
  // 용어에 "|"가 없다는 전제 하에 역시 대칭 — 다른 턴이면 다른 키
  assert.notEqual(glossaryCacheKey('BranchPort', 'turn-1'), glossaryCacheKey('BranchPort', 'turn-2'));
  assert.notEqual(glossaryCacheKey('A', 'turn-1'), glossaryCacheKey('B', 'turn-1'));
});

test('snippetFingerprint — 같은 텍스트는 같은 지문, 다른 텍스트는 다른 지문', () => {
  const a = snippetFingerprint('BranchPort는 세션 로그를 트리로 시각화한다');
  const b = snippetFingerprint('BranchPort는 세션 로그를 트리로 시각화한다');
  const c = snippetFingerprint('다른 스니펫 텍스트');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 12); // vec store lk 지문과 같은 길이(sha1 → base64 앞 12자)
});

// ── 캐시 대조: 히트/미스 분리 ──────────────────────────────────────────
test('splitGlossaryCache — 캐시에 없는 키는 전량 미스(신규 프로젝트와 동일)', () => {
  const ev = [evidence('BranchPort', 't1', 'BranchPort는 트리 시각화 도구다')];
  const { hits, misses } = splitGlossaryCache(ev, {});
  assert.equal(hits.length, 0);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].term, 'BranchPort');
});

test('splitGlossaryCache — 키와 스니펫 지문이 모두 일치하면 히트', () => {
  const snippet = 'MoLock은 실시간 캠 기반 포인트 시스템이다';
  const ev = [evidence('MoLock', 't1', snippet, '2026-08-04T11:00:00Z')];
  const cache = {
    [glossaryCacheKey('MoLock', 't1')]: {
      def: 'MoLock: 실시간 캠 기반 포인트 시스템', ts: '2026-08-04T11:00:00Z',
      snippetKey: snippetFingerprint(snippet),
    },
  };
  const { hits, misses } = splitGlossaryCache(ev, cache);
  assert.equal(hits.length, 1);
  assert.equal(misses.length, 0);
  assert.equal(hits[0].term, 'MoLock');
  assert.equal(hits[0].def, 'MoLock: 실시간 캠 기반 포인트 시스템');
  assert.equal(hits[0].turnId, 't1');
});

test('splitGlossaryCache — snippetKey 불일치는 미스로 취급(근거가 바뀐 경우 재생성)', () => {
  const ev = [evidence('MoLock', 't1', '바뀐 스니펫 텍스트 — 2번째 조각이 범위 따라 흔들린 경우')];
  const cache = {
    [glossaryCacheKey('MoLock', 't1')]: {
      def: '옛 정의', ts: '2026-08-04T11:00:00Z', snippetKey: snippetFingerprint('원래 스니펫 텍스트'),
    },
  };
  const { hits, misses } = splitGlossaryCache(ev, cache);
  assert.equal(hits.length, 0, '지문이 다르면 캐시를 신뢰하지 않는다');
  assert.equal(misses.length, 1);
});

test('splitGlossaryCache — 같은 용어라도 정의턴id가 다르면 별개 키(다른 근거)', () => {
  const ev = [evidence('BranchPort', 't2', '두 번째 정의 스니펫')];
  const cache = {
    [glossaryCacheKey('BranchPort', 't1')]: {
      def: '첫 번째 정의', ts: null, snippetKey: snippetFingerprint('첫 번째 정의 스니펫'),
    },
  };
  const { hits, misses } = splitGlossaryCache(ev, cache);
  assert.equal(hits.length, 0, 't1 캐시는 t2 근거에 적용되면 안 된다');
  assert.equal(misses.length, 1);
});

// ── 병합: 새 항목만 추가 ───────────────────────────────────────────────
test('mergeGlossaryCache — 새로 생성된 정의만 추가하고 기존 키는 보존한다(무효화 없음)', () => {
  const existing = {
    [glossaryCacheKey('Old', 't0')]: { def: '기존 정의', ts: null, snippetKey: 'aaaaaaaaaaaa' },
  };
  const ev = [evidence('New', 't1', '새 용어 스니펫')];
  const items = [{ term: 'New', def: '새 정의', turnId: 't1', ts: '2026-08-04T12:00:00Z' }];
  const next = mergeGlossaryCache(existing, ev, items);
  assert.equal(Object.keys(next).length, 2);
  assert.deepEqual(next[glossaryCacheKey('Old', 't0')], existing[glossaryCacheKey('Old', 't0')], '기존 항목은 그대로');
  const added = next[glossaryCacheKey('New', 't1')];
  assert.equal(added.def, '새 정의');
  assert.equal(added.snippetKey, snippetFingerprint('새 용어 스니펫'));
});

test('mergeGlossaryCache — evidence에 없는 term은 방어적으로 캐시하지 않는다', () => {
  const next = mergeGlossaryCache({}, [], [{ term: 'Ghost', def: '?', turnId: 't1', ts: null }]);
  assert.equal(Object.keys(next).length, 0);
});

// ── fs 로드/저장 왕복 ──────────────────────────────────────────────────
test('loadGlossaryCache/saveGlossaryCache — 왕복 후 내용이 동일하다', () => {
  const file = tmpFile('roundtrip.glossary.json');
  const cache = {
    [glossaryCacheKey('A', 't1')]: { def: 'A 정의', ts: '2026-08-04T10:00:00Z', snippetKey: snippetFingerprint('a') },
    [glossaryCacheKey('B', 't2')]: { def: 'B 정의', ts: null, snippetKey: snippetFingerprint('b') },
  };
  saveGlossaryCache(file, cache);
  const loaded = loadGlossaryCache(file);
  assert.deepEqual(loaded, cache);
});

test('loadGlossaryCache — 파일이 없으면 빈 캐시(loadVecStore/loadLabels와 같은 관용 로드)', () => {
  const file = tmpFile('missing.glossary.json');
  assert.deepEqual(loadGlossaryCache(file), {});
});

test('loadGlossaryCache — 손상된 JSON은 예외를 던지지 않고 빈 캐시로 시작한다', () => {
  const file = tmpFile('corrupt.glossary.json');
  fs.writeFileSync(file, '{not valid json,,,');
  assert.deepEqual(loadGlossaryCache(file), {});
});

test('loadGlossaryCache — 객체가 아닌 JSON(예: 배열)도 빈 캐시로 관용 처리한다', () => {
  const file = tmpFile('array.glossary.json');
  fs.writeFileSync(file, '[1,2,3]');
  assert.deepEqual(loadGlossaryCache(file), {});
});

test('saveGlossaryCache — 상위 디렉터리가 없으면 생성한다(labels/ mkdir 관용과 동일)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-glossary-'));
  const file = path.join(dir, 'nested', 'proj.glossary.json');
  saveGlossaryCache(file, { [glossaryCacheKey('X', 't1')]: { def: 'x', ts: null, snippetKey: 'bbbbbbbbbbbb' } });
  assert.ok(fs.existsSync(file));
  assert.deepEqual(loadGlossaryCache(file), { [glossaryCacheKey('X', 't1')]: { def: 'x', ts: null, snippetKey: 'bbbbbbbbbbbb' } });
});
