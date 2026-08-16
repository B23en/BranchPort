// 사용자 설정 파일 — 압축 프롬프트 템플릿·시스템 프롬프트를 사용자 파일로 갈아끼운다.
//
// 위치: $BRANCHPORT_HOME (기본 ~/.branchport)
//   compact-prompt.md   압축 프롬프트 템플릿 전체 (문법은 prompt.ts 상단 주석)
//   compact-system.md   claude -p --system-prompt 로 넘기는 시스템 프롬프트 (선택)
//
// 원칙:
//  - 호출마다 읽는다(재시작 불필요, 비용 무시 가능). 캐시 없음.
//  - 파싱 실패·필수 자리표시자 누락은 조용히 넘기지 않는다 — 내장 기본값으로 폴백하고
//    console.warn + 결과 meta에 사유를 남긴다.
//  - CLAUDE.md는 쓰지 않는다: --system-prompt 호출은 CLAUDE.md를 로드하지 않고(실측), cwd가
//    tmp라 프로젝트 CLAUDE.md는 발견도 안 되며, 코딩 세션 지시와 배치 작업 설정을 섞으면
//    서로 오염된다. (docs/2026-08-15-compact-피드백및개선.md §7)
//  - 프로젝트별 덮어쓰기(<cwd>/.branchport/…)는 2단계 — 파일 하나로 시작한다.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { DEFAULT_COMPACT_TEMPLATE, COMPACT_SYSTEM_PROMPT, validateTemplate } from './prompt';

export const BRANCHPORT_HOME = process.env.BRANCHPORT_HOME || path.join(os.homedir(), '.branchport');
export const COMPACT_TEMPLATE_FILE = path.join(BRANCHPORT_HOME, 'compact-prompt.md');
export const COMPACT_SYSTEM_FILE = path.join(BRANCHPORT_HOME, 'compact-system.md');

export interface LoadedText {
  source: 'builtin' | string;   // 'builtin' 또는 실제 파일 경로
  text: string;
  sha1: string;                 // 실측 재현성 — 어떤 프롬프트로 만든 패키지인지 meta에 남긴다
  error?: string;               // 파일이 있었지만 쓰지 못한 이유 (폴백됨)
  warnings?: string[];
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);

function readIfExists(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// 압축 프롬프트 템플릿 — 파일이 있고 유효하면 그것, 아니면 내장 기본값.
export function loadCompactTemplate(): LoadedText {
  const raw = readIfExists(COMPACT_TEMPLATE_FILE);
  if (raw === null) return { source: 'builtin', text: DEFAULT_COMPACT_TEMPLATE, sha1: sha1(DEFAULT_COMPACT_TEMPLATE) };
  const text = raw.replace(/\r\n/g, '\n');
  const check = validateTemplate(text);
  if (!check.ok) {
    const error = `${COMPACT_TEMPLATE_FILE}: ${check.errors.join(' / ')} — 내장 기본 템플릿으로 진행`;
    console.warn('[compact 템플릿] ' + error);
    return { source: 'builtin', text: DEFAULT_COMPACT_TEMPLATE, sha1: sha1(DEFAULT_COMPACT_TEMPLATE), error, warnings: check.warnings };
  }
  for (const w of check.warnings) console.warn(`[compact 템플릿] ${COMPACT_TEMPLATE_FILE}: ${w}`);
  return { source: COMPACT_TEMPLATE_FILE, text, sha1: sha1(text), warnings: check.warnings.length ? check.warnings : undefined };
}

// 시스템 프롬프트 — 파일이 있으면 그것(빈 파일은 무시), 아니면 내장.
export function loadCompactSystemPrompt(): LoadedText {
  const raw = readIfExists(COMPACT_SYSTEM_FILE);
  const text = raw?.replace(/\r\n/g, '\n').trim();
  if (!text) return { source: 'builtin', text: COMPACT_SYSTEM_PROMPT, sha1: sha1(COMPACT_SYSTEM_PROMPT) };
  return { source: COMPACT_SYSTEM_FILE, text, sha1: sha1(text) };
}

// 기본값을 파일로 내보내기 — 커스텀의 시작점. 이미 있는 파일은 덮어쓰지 않는다.
export function exportCompactDefaults(): { written: string[]; skipped: string[] } {
  fs.mkdirSync(BRANCHPORT_HOME, { recursive: true });
  const written: string[] = [], skipped: string[] = [];
  const put = (file: string, text: string) => {
    if (fs.existsSync(file)) { skipped.push(file); return; }
    fs.writeFileSync(file, text, 'utf8');
    written.push(file);
  };
  put(COMPACT_TEMPLATE_FILE, DEFAULT_COMPACT_TEMPLATE);
  put(COMPACT_SYSTEM_FILE, COMPACT_SYSTEM_PROMPT + '\n');
  return { written, skipped };
}
