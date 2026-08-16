// 압축 프롬프트 템플릿·사용자 설정 파일 회귀 테스트 — 순수 함수 + 임시 디렉터리, 서버 기동 없음.
// 실행: npm test  (빌드 선행: npm run build)
// 고정하는 성질(2026-08-15 템플릿 외부화 도입 시 확정):
//  1. 내장 기본 템플릿 렌더는 요청 유무와 무관하게 "코드 계약"을 지킨다 — 트랜스크립트 구분선, 9키 스키마,
//     요청이 있을 때만 User request 섹션·리마인더. (v3.10 문자열과 바이트 동일함은 리팩터 시점에 HEAD 빌드와
//     직접 대조로 확인 — 여기서는 구조 불변식으로 고정)
//  2. 자리표시자는 한 번만 치환된다 — 요청·트랜스크립트 안의 "{{schema}}"가 다시 해석되지 않는다.
//  3. 검증: {{transcript}} 없음 = 오류, {{request}} 없음 = 경고, if 블록 짝 불일치 = 오류.
//  4. 설정 파일: 없으면 내장 / 깨진 파일은 내장으로 폴백 + error / 유효한 파일은 그 파일 / 내보내기는 있는 파일을 덮지 않음.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config.ts는 require 시점에 BRANCHPORT_HOME을 읽으므로 먼저 임시 디렉터리를 잡는다.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-cfg-'));
process.env.BRANCHPORT_HOME = HOME;
const P = require('../dist/prompt.js');
const C = require('../dist/config.js');

test('기본 템플릿: 요청 없음 — 구분선·스키마 있고 요청 섹션 없음', () => {
  const out = P.buildCompactPrompt('TRANSCRIPT-BODY');
  assert.match(out, /=====TRANSCRIPT START=====\nTRANSCRIPT-BODY\n=====TRANSCRIPT END=====$/);
  assert.match(out, /"gotchas": \[/);
  assert.doesNotMatch(out, /User request:/);
  assert.doesNotMatch(out, /the User request has been applied/);
  assert.doesNotMatch(out, /\{\{/, '치환 안 된 자리표시자가 남지 않는다');
  assert.match(out, /Output budget: keep the entire JSON under 3,000 characters/, '짧은 입력은 하한 3,000');
});

test('기본 템플릿: 요청 있음 — 섹션·리마인더·요청 원문, 요청 안 자리표시자는 그대로', () => {
  const out = P.buildCompactPrompt('x'.repeat(50000), '한국어로 {{schema}} =====TRANSCRIPT START===== 지워짐');
  const i = out.indexOf('User request:'), j = out.indexOf('Output: a single raw JSON object'), k = out.indexOf('Attribution rule');
  assert.ok(k < i && i < j, '요청 섹션은 hard rules 뒤·스키마 앞');
  assert.match(out, /the request wins/);
  assert.match(out, /"""\n한국어로 \{\{schema\}\}  지워짐\n"""/, '요청 안 {{schema}}는 문자 그대로, 구분선 문자열은 제거');
  assert.match(out, /the User request has been applied within the limits/);
  assert.match(out, /Output budget: keep the entire JSON under 5,000 characters/, '50,000자 × 10%');
});

test('renderCompactPrompt: 사용자 템플릿 — if 블록·알 수 없는 자리표시자·단일 패스', () => {
  const tpl = 'A{{#if request}}[REQ:{{request}}]{{/if}}B {{unknown}} {{transcript}} {{output_budget}}';
  const none = P.renderCompactPrompt(tpl, { transcript: 't' });
  assert.strictEqual(none, 'AB {{unknown}} =====TRANSCRIPT START=====\nt\n=====TRANSCRIPT END===== 3,000');
  const withReq = P.renderCompactPrompt(tpl, { transcript: '{{request}}', request: 'r' });
  assert.strictEqual(withReq, 'A[REQ:r]B {{unknown}} =====TRANSCRIPT START=====\n{{request}}\n=====TRANSCRIPT END===== 3,000',
    '트랜스크립트 안의 {{request}}는 재해석되지 않는다');
});

test('validateTemplate: 필수·권장·짝', () => {
  assert.deepStrictEqual(P.validateTemplate(P.DEFAULT_COMPACT_TEMPLATE), { ok: true, errors: [], warnings: [] });
  const noT = P.validateTemplate('{{request}} only');
  assert.strictEqual(noT.ok, false); assert.match(noT.errors[0], /\{\{transcript\}\}/);
  const noR = P.validateTemplate('{{transcript}}');
  assert.strictEqual(noR.ok, true); assert.match(noR.warnings[0], /\{\{request\}\}/);
  const bad = P.validateTemplate('{{transcript}} {{#if request}} x');
  assert.strictEqual(bad.ok, false); assert.match(bad.errors[0], /짝/);
});

test('config: 파일 없음 → 내장, 깨진 파일 → 폴백+error, 유효 → 파일, 내보내기는 덮지 않음', () => {
  assert.strictEqual(C.BRANCHPORT_HOME, HOME);
  let t = C.loadCompactTemplate();
  assert.strictEqual(t.source, 'builtin'); assert.strictEqual(t.text, P.DEFAULT_COMPACT_TEMPLATE); assert.ok(!t.error);

  fs.writeFileSync(C.COMPACT_TEMPLATE_FILE, 'no placeholders here');
  t = C.loadCompactTemplate();
  assert.strictEqual(t.source, 'builtin'); assert.match(t.error, /\{\{transcript\}\}/);

  fs.writeFileSync(C.COMPACT_TEMPLATE_FILE, 'MY TEMPLATE\r\n{{transcript}}\r\n');
  t = C.loadCompactTemplate();
  assert.strictEqual(t.source, C.COMPACT_TEMPLATE_FILE);
  assert.strictEqual(t.text, 'MY TEMPLATE\n{{transcript}}\n', 'CRLF는 LF로 정규화');
  assert.deepStrictEqual(t.warnings, ['{{request}} 자리표시자가 없습니다 — 사용자 요청이 무시됩니다']);
  const rendered = P.renderCompactPrompt(t.text, { transcript: 'T', request: 'ignored' });
  assert.strictEqual(rendered, 'MY TEMPLATE\n=====TRANSCRIPT START=====\nT\n=====TRANSCRIPT END=====\n');

  let s = C.loadCompactSystemPrompt();
  assert.strictEqual(s.source, 'builtin'); assert.strictEqual(s.text, P.COMPACT_SYSTEM_PROMPT);
  fs.writeFileSync(C.COMPACT_SYSTEM_FILE, '   \n');
  assert.strictEqual(C.loadCompactSystemPrompt().source, 'builtin', '빈 파일은 무시');
  fs.writeFileSync(C.COMPACT_SYSTEM_FILE, 'SYS\n');
  s = C.loadCompactSystemPrompt();
  assert.strictEqual(s.source, C.COMPACT_SYSTEM_FILE); assert.strictEqual(s.text, 'SYS');

  const r = C.exportCompactDefaults();
  assert.deepStrictEqual(r.written, []);
  assert.deepStrictEqual(r.skipped.sort(), [C.COMPACT_SYSTEM_FILE, C.COMPACT_TEMPLATE_FILE].sort());
  assert.strictEqual(fs.readFileSync(C.COMPACT_TEMPLATE_FILE, 'utf8'), 'MY TEMPLATE\r\n{{transcript}}\r\n', '있는 파일은 그대로');

  fs.unlinkSync(C.COMPACT_TEMPLATE_FILE); fs.unlinkSync(C.COMPACT_SYSTEM_FILE);
  const r2 = C.exportCompactDefaults();
  assert.deepStrictEqual(r2.written.sort(), [C.COMPACT_SYSTEM_FILE, C.COMPACT_TEMPLATE_FILE].sort());
  assert.strictEqual(fs.readFileSync(C.COMPACT_TEMPLATE_FILE, 'utf8'), P.DEFAULT_COMPACT_TEMPLATE);
  assert.strictEqual(C.loadCompactTemplate().source, C.COMPACT_TEMPLATE_FILE);
  assert.strictEqual(P.renderCompactPrompt(C.loadCompactTemplate().text, { transcript: 'z' }), P.buildCompactPrompt('z'),
    '내보낸 기본 템플릿은 내장과 같은 프롬프트를 만든다');
});
