# CLAUDE.md

BranchPort 저장소에서 작업하는 AI 에이전트(Claude Code / Codex)와 팀원 모두가 따르는 **규칙 정본**입니다.

- 용어를 모르겠으면 → [GLOSSARY.md](./GLOSSARY.md)
- 이 프로젝트가 어디로 가는지 → [DIRECTION.md](./DIRECTION.md)

---

## 프로젝트 한 줄 요약

Claude Code가 남기는 세션 로그(`~/.claude/projects/**/*.jsonl`)를 파싱해서 **하나의 트리로 시각화하는 완전 로컬 도구**입니다. 흩어진 세션 파일·서브에이전트 기록·되돌리기 분기를 지하철 노선도 한 장으로 합쳐 보여줍니다.

## 코드 구조 — 5단계 파이프라인

| 단계 | 파일 | 책임 |
|---|---|---|
| ① 탐색 | `src/discover.ts` | `~/.claude/projects`를 훑어 프로젝트·세션 파일 목록화 |
| ② 파싱 | `src/parser.ts` | JSONL 한 줄씩 해석. 노이즈 제거, 시크릿 마스킹, 도구 분류 |
| ③ 병합 | `src/tree.ts` | 여러 파일을 uuid 부모-자식 관계로 한 트리에 병합. 포크 접붙이기, resume 중복 제거 |
| ④ 턴 접기 | `src/turns.ts` | Q/A 노드를 사람이 읽는 **턴** 단위로 축약. 진짜 분기는 접지 않고 유지 |
| ⑤ 서버 | `src/server.ts` | HTTP API 3종 + 압축 패키지 생성 |
| 프론트 | `public/index.html` | 의존성 없는 단일 파일 (CSS·JS 인라인) |

**수정하기 전에 해당 단계의 파일부터 읽으세요.** 단계를 건너뛰고 고치면 다른 단계가 조용히 깨집니다. 예를 들어 파싱 단계에서 노드를 버리면 병합 단계의 부모-자식 연결이 끊깁니다.

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

## 코드 규칙

- **런타임 의존성 0개를 유지합니다.** `devDependencies`는 `typescript`와 `@types/node` 뿐입니다. 라이브러리나 프레임워크를 추가하지 마세요. 필요해 보이면 먼저 이슈로 논의합니다.
- **프론트엔드는 `public/index.html` 단일 파일입니다.** 번들러·빌드 도구를 도입하지 않습니다.
- **주석은 "무엇을"이 아니라 "왜"를 씁니다.** 기존 코드의 주석 밀도와 톤을 그대로 따르세요. 코드를 읽으면 아는 내용은 적지 않고, 그렇게 짠 이유가 비직관적일 때만 적습니다.
- **파일별 책임 경계를 넘지 않습니다.** 파싱 로직을 `tree.ts`에 넣거나, 레이아웃 계산을 서버로 옮기지 마세요.
- **서버는 `127.0.0.1`에만 바인딩합니다.** 외부 노출용 코드를 추가하지 않습니다.

---

## 금지 사항

- `dist/` `node_modules/` `packages/` 커밋 금지 (`.gitignore`에 등록되어 있습니다)
- **실제 세션 로그나 압축 패키지 내용을 저장소·PR·이슈에 붙여넣지 마세요.** 대화 원문과 로컬 파일 경로가 그대로 들어 있습니다. 재현이 필요하면 내용을 지어내서 최소 예시를 만드세요.
- **시크릿 마스킹을 약화시키지 마세요.** `src/parser.ts`의 `SECRET_RE`는 로그에 실제로 찍힌 API 키가 화면·저장 파일로 새어나가는 것을 막는 장치입니다.
- `main` 직접 push, force push 금지
