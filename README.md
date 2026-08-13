# BranchPort

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

## 기여하기

작업 규칙(브랜치 · PR · 머지 절차)과 코드 규칙은 [CLAUDE.md](./CLAUDE.md)에 있습니다.
용어는 [GLOSSARY.md](./GLOSSARY.md), 프로젝트 방향과 하지 않을 것들은 [DIRECTION.md](./DIRECTION.md)를 참고하세요.

## 참고

- 서버는 `127.0.0.1`에만 바인딩되는 완전 로컬 도구입니다. 외부에 노출하지 마세요.
- 압축, 턴 제목·요약 생성, 갈래 대화 — 이 세 기능은 로컬에 설치된 `claude` CLI(`claude -p`)를 서브프로세스로 호출합니다. CLI가 없으면 이 세 기능만 동작하지 않고, 트리 시각화 자체는 정상 동작합니다.
