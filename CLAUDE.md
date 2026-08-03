# CLAUDE.md

BranchPort 저장소에서 작업하는 AI 에이전트(Claude Code / Codex)와 팀원 모두가 따르는 **규칙 정본**입니다.

- 용어를 모르겠으면 → [GLOSSARY.md](./GLOSSARY.md)
- 이 프로젝트가 어디로 가는지 → [DIRECTION.md](./DIRECTION.md)

---

## 프로젝트 한 줄 요약

Claude Code가 남기는 세션 로그(`~/.claude/projects/**/*.jsonl`)를 파싱해서 **하나의 트리로 시각화하는 완전 로컬 도구**입니다. 흩어진 세션 파일·서브에이전트 기록·되돌리기 분기를 지하철 노선도 한 장으로 합쳐 보여줍니다.

---

## 작업 규칙 — PR 워크플로 (필수)

**`main`에 직접 커밋하거나 push하지 않습니다.** 저장소 규칙으로도 차단되어 있어 시도하면 거부됩니다.

아래 순서를 그대로 따르세요.

```bash
# 1) 최신 상태로 동기화
git checkout main && git pull --rebase origin main

# 2) 브랜치 생성 (접두사: feat/ fix/ docs/ chore/)
git checkout -b feat/<짧은-주제>

# 3) 작업하고 커밋

# 4) 원격에 올리기
git push -u origin feat/<짧은-주제>

# 5) PR 생성 — 무엇을/왜를 반드시 적습니다
gh pr create --title "feat: 턴 필터 추가" --body "## 무엇을
- 턴 목록을 phase별로 거르는 기능 추가

## 왜
- 세션이 길어지면 편집 턴만 보고 싶은 경우가 많음"

# 6) 본인이 머지 (승인이 아니라 머지입니다)
gh pr merge --squash --delete-branch

# 7) 다시 동기화
git checkout main && git pull --rebase origin main
```

### 규칙 세부 사항

- **리뷰는 필수가 아닙니다. 본인이 바로 머지합니다.** 다만 머지 직전에 PR의 diff를 반드시 한 번 훑어보세요. 에이전트가 의도치 않게 건드린 파일을 잡아낼 수 있는 마지막 지점입니다.
- **본인 PR에 `gh pr review --approve`를 시도하지 마세요.** GitHub이 자기 PR 승인을 막아두었기 때문에 에러만 납니다. 승인 없이 바로 `gh pr merge`가 정상 경로입니다.
- **머지는 항상 squash.** PR 1개 = 커밋 1개. 저장소 설정에서 squash 외의 머지 방식은 꺼져 있습니다.
- **동기화는 항상 `--rebase`.** merge 커밋을 만들지 않아 히스토리가 선형으로 유지됩니다.
- 머지하면 원격 브랜치는 자동 삭제됩니다.
- 커밋 메시지 접두사는 브랜치 접두사와 맞춥니다: `feat:` `fix:` `docs:` `chore:`

---

## 빌드 / 실행

```bash
npm install
npx tsc -p .
node dist/server.js
```

정상 기동되면 `http://127.0.0.1:4300`이 자동으로 열립니다.
Claude Code에서는 `/branchport` 슬래시 커맨드로 빌드+실행이 한 번에 됩니다 (`.claude/commands/branchport.md`).

---

## 문서 보관 — `docs/`

작업 과정에서 나온 **기획서 · 보고서 · 회의록 · 설계 메모** 등의 문서 파일은 [`docs/`](./docs/)에 보관합니다.

- 파일명은 `YYYY-MM-DD-주제.md` 형식을 권장합니다
- `CLAUDE.md` · `GLOSSARY.md` · `DIRECTION.md`는 계속 갱신되는 기준 문서이므로 루트에 그대로 둡니다
