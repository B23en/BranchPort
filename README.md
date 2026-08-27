# BranchPort

[![CI](https://github.com/B23en/BranchPort/actions/workflows/ci.yml/badge.svg)](https://github.com/B23en/BranchPort/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![for Claude Code](https://img.shields.io/badge/for-Claude%20Code-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](./CONTRIBUTING.md)

Claude Code 세션 로그(`~/.claude/projects/`)를 파싱해서 트리/그래프로 시각화하는 로컬 도구입니다.

## 설치 & 실행

```bash
npm install
npx tsc -p .
node dist/server.js
```

정상 기동되면 `http://127.0.0.1:4300`이 자동으로 브라우저에서 열립니다.

## Claude Code 슬래시 커맨드로 실행

이 폴더를 프로젝트 루트로 열고 `.claude/commands/branchport.md`가 있는 상태에서
새 Claude Code 세션을 시작하면 `/branchport` 커맨드로 빌드+실행까지 한 번에 됩니다.
(커맨드 목록은 세션 시작 시 고정되므로, 새로 받은 직후엔 세션을 한 번 새로 시작해야 인식됩니다.)

## 과거 세션 검색 스킬 (branchport-recall)

`.claude/skills/branchport-recall/`는 로컬에 떠 있는 BranchPort 서버(포트 4300)로 과거
세션을 검색·인출하는 Claude Code 스킬입니다. 이 레포 안에서만 발동되게 하려면 그대로 두면
되고, **모든 프로젝트에서 발동**되게 하려면 `~/.claude/skills/`로 복사하세요:

```bash
cp -r .claude/skills/branchport-recall ~/.claude/skills/
```

## 어디서든 쓰기 (전역 설치)

**서버는 실행 위치와 무관합니다.** 세션 로그는 `~/.claude/projects/` 전체를 읽고 설정은
`~/.branchport/`에서 가져오므로, 어느 폴더에서 띄우든 **모든 프로젝트가 화면의 드롭다운에
나옵니다.** 이 저장소를 열지 않아도 됩니다.

폴더에 묶이는 것은 **부르는 방법**뿐입니다. 아래 두 파일을 홈으로 복사하면 어느 세션에서든
쓸 수 있습니다.

**① 과거 세션 검색 스킬** — 위 절의 `cp` 한 줄이면 끝입니다.

**② `/branchport` 커맨드** — 저장소 위치를 알려줘야 하므로 복사 후 경로를 한 줄 고칩니다.

```bash
mkdir -p ~/.claude/commands
cp .claude/commands/branchport.md ~/.claude/commands/
```

복사한 `~/.claude/commands/branchport.md`를 열어, 저장소를 상대경로로 가리키는 부분을
**클론해 둔 실제 경로**로 바꾸세요.

```diff
- 프로젝트 루트(`package.json`이 있는 디렉토리, 이 커맨드 파일 기준 `../../`)에서
+ 프로젝트 루트(`/path/to/BranchPort`)에서
```

새 Claude Code 세션부터 어느 폴더에서든 `/branchport`가 뜹니다.
(커맨드 목록은 세션 시작 시 고정되므로 한 번 새로 시작해야 합니다.)

> 이 방식은 **본인 컴퓨터에서만** 동작합니다. 경로가 사람마다 다르기 때문입니다.
> 설치 경로를 신경 쓰지 않아도 되는 플러그인 형태의 배포는 준비 중입니다.

## 압축 프롬프트 바꾸기

압축(요약)에 쓰는 프롬프트는 통째로 사용자 파일로 갈아끼울 수 있습니다. 기본값을 파일로 내보낸 뒤 고치세요:

```bash
node dist/server.js --export-compact-config
# → ~/.branchport/compact-prompt.md   (프롬프트 템플릿)
#   ~/.branchport/compact-system.md   (시스템 프롬프트)
```

(화면의 도움말 `?` → "프롬프트 바꾸기"의 버튼으로도 됩니다.) 파일은 호출마다 다시 읽으므로 재시작이 필요 없습니다.
템플릿 자리표시자는 `{{transcript}}`(필수) · `{{request}}`(압축 시 입력한 요청) · `{{schema}}` · `{{output_budget}}` ·
`{{#if request}}…{{/if}}` 다섯 가지이고, `{{transcript}}`가 없거나 문법이 깨지면 내장 기본값으로 돌아갑니다.
위치는 `BRANCHPORT_HOME` 환경변수로 바꿀 수 있습니다. 압축 시 요청란에 적는 한 줄("받는 사람 · 강조 · 언어")은
기본 규칙보다 우선하므로, 매번 다른 지시는 요청란에, 항상 같은 지시는 템플릿 파일에 두면 됩니다.
요청란 옆 `?`를 누르면 예시 양식(클릭하면 채워짐)과 프롬프트 파일 안내가 그 자리에서 뜨고, 요청란은 내용에 맞춰
최대 5줄까지 자동으로 늘어납니다(상한 2,000자).

## 기여하기

기여 절차(개발 환경 · 검증 · Fork 기반 PR)는 [CONTRIBUTING.md](./CONTRIBUTING.md)에 있습니다.
버그 신고와 기능 제안은 [이슈](https://github.com/B23en/BranchPort/issues)로 받습니다.

용어는 [GLOSSARY.md](./GLOSSARY.md), 프로젝트 방향과 하지 않을 것들은 [DIRECTION.md](./DIRECTION.md)를 참고하세요.
팀원용 작업 규칙(브랜치 · PR · 머지 절차)은 [CLAUDE.md](./CLAUDE.md)에 있습니다.

## 라이선스

[MIT License](./LICENSE) — 자유롭게 사용·수정·재배포할 수 있습니다.

런타임 의존성은 없으며, 빌드에만 쓰는 devDependencies(TypeScript — Apache-2.0, `@types/node` — MIT)도 모두 허용형 라이선스입니다.

## 참고

- 서버는 `127.0.0.1`에만 바인딩되는 완전 로컬 도구입니다. 외부에 노출하지 마세요.
- 압축, 턴 제목·요약 생성, 갈래 대화 — 이 세 기능은 로컬에 설치된 `claude` CLI(`claude -p`)를 서브프로세스로 호출합니다. CLI가 없으면 이 세 기능만 동작하지 않고, 트리 시각화 자체는 정상 동작합니다.
