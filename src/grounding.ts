import { Turn } from './types';
import { identTokens } from './glossary';

// 근거 원문 대조(grounding): 스킬 문장 속 verbatim 토큰(명령·파일·식별자·수치)이
// 근거 턴 원문에 실제 등장하는지 문자열 대조한다. "앵커 번호가 범위 안인가"를 넘어
// "내용이 근거에 실제로 있는가"를 기계 검증 — 원본 로그를 보유한 로컬 도구만 가능.
// 순수 함수로 분리해 서버 기동 없이 test/grounding.test.js에서 단위 테스트한다.
export function groundingCheck(
  text: string, t: Turn, toolResults: Map<string, string> = new Map(),
): { found: number; total: number } {
  const idToks = new Set<string>(identTokens(text).keys());
  const numToks = new Set<string>();
  for (const m of text.matchAll(/\b\d{2,}\b/g)) numToks.add(m[0]); // 수치 — QA 실측 최다 손실 유형
  const total = idToks.size + numToks.size;
  if (!total) return { found: 0, total: 0 };
  // 대조 소스: 질문·응답 + 도구 입력 프리뷰 + 도구 결과(가능하면 저장본 — 파서 단계에서 1,500자로 절단됨, forest.toolResults가
  // 없으면 파서가 90자로 자른 프리뷰) — 에러 문구는 tool result에만 사는 경우가 많아 이걸
  // 빼면 gotcha 대조가 항상 "원문 대조 0/N"으로 오탐한다 (8/12 실측).
  const toolText = t.tools.map(x => {
    const full = x.toolUseId ? toolResults.get(x.toolUseId) : undefined;
    return x.inputPreview + ' ' + (full ?? x.resultPreview ?? '');
  }).join(' ');
  const src = (t.prompt + ' ' + t.answer + ' ' + toolText).toLowerCase();
  let found = 0;
  for (const k of idToks) if (src.includes(k.toLowerCase())) found++;
  // 수치는 부분 문자열 오탐이 심해 단어 경계로 대조한다. \b만으로는 부족하다 —
  // "-"는 비단어 문자라 "2026-08-12"의 "12" 앞에도 \b 경계가 생겨 "12"가 오매치된다.
  // 배제 클래스는 [\w-]여야 한다: [\d-]만 쓰면 "v12"·"sha256"처럼 영문자에 붙은
  // 숫자열이 새로 오매치된다(리뷰 실측 8케이스). \w는 한글을 안 포함하므로 "포트4300"
  // 같은 정상 케이스는 그대로 잡힌다.
  for (const k of numToks) if (new RegExp(`(?<![\\w-])${k}(?![\\w-])`).test(src)) found++;
  return { found, total };
}
