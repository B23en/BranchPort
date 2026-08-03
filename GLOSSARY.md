# GLOSSARY.md

BranchPort 코드베이스는 **용어를 모르면 읽히지 않습니다.** 같은 대상을 단계마다 다른 이름으로 부르기 때문입니다(레코드 → 노드 → 턴). 아래 정의는 전부 실제 코드 기준이며, 각 항목에 해당 코드 위치를 붙여두었으니 헷갈리면 바로 열어보세요.

---

## 데이터 원본

### 세션 파일 (Session file)
Claude Code가 대화 하나를 기록하는 `.jsonl` 파일. 경로는 `~/.claude/projects/<인코딩된-프로젝트-경로>/<세션UUID>.jsonl`이고, **한 줄에 JSON 객체 하나**가 들어 있습니다. 폴더 이름은 작업 경로의 `/`를 `-`로 바꾼 것이라 사람이 읽기 어려워서, 첫 줄의 `cwd` 필드에서 진짜 경로를 뽑아 표시합니다.
> `src/discover.ts:28` (`readCwdFromSession`)

### 레코드 (Record)
세션 파일의 한 줄. `uuid`와 `parentUuid`를 갖고 있어서 줄 사이에 부모-자식 관계가 생깁니다. 파일은 평평한 줄 목록이지만 실제 구조는 트리입니다.

### resume 중복
이어받기(`--continue`, `--resume`) 세션은 **이전 세션의 레코드를 uuid까지 그대로 복사**해서 새 파일에 다시 씁니다. 그대로 합치면 같은 대화가 두 벌로 그려지므로, uuid를 키로 Map에 넣어 자연스럽게 덮어쓰는 방식으로 제거합니다. 그래서 노드 수는 파일별로 더하지 않고 마지막에 한 번 셉니다.
> `src/tree.ts:68` (주석), `src/tree.ts:147`

---

## 파싱 단계 용어

### 살아남은 노드 / 통과 노드 (kept / pass-through)
파싱 결과 **화면에 그릴 대상**이 되는 레코드를 "살아남은 노드"라 합니다. 도구 결과만 담긴 레코드나 훅이 주입한 텍스트는 그리지 않지만, **부모 링크는 남겨둡니다.** 그래야 그 아래 진짜 대화가 위로 다시 연결됩니다. 이 재연결을 하는 함수가 `nearestKeptAncestor`입니다.
> `src/parser.ts:209`, `src/tree.ts:21`

### 가짜 프롬프트 (fake prompt)
`type: "user"`로 저장되지만 사람이 친 것이 아닌 레코드. 훅 출력, 시스템 알림, 명령어 에코 등이 해당합니다. `<system-reminder>`, `<command-name>`, `<bash-input>` 같은 접두사로 판별해 걸러냅니다.
> `src/parser.ts:14` (`FAKE_PREFIXES`)

### 시크릿 마스킹
세션 로그에 API 키가 그대로 찍히는 경우가 실제로 있어서, `sk-ant-…` `ghp_…` `AKIA…` JWT 등을 정규식으로 잡아 `•••masked•••`로 치환합니다. **브라우저로도, 저장되는 압축 패키지로도 원문이 나가지 않습니다.**
> `src/parser.ts:23` (`SECRET_RE`), `src/parser.ts:29` (`sanitize`)

### 도구 분류 (ToolCategory)
모든 도구 호출을 4종으로 나눕니다. 이 분류가 나중에 노드 **색**이 됩니다.

| 카테고리 | 해당 도구 |
|---|---|
| `edit` | Edit, Write, NotebookEdit |
| `exec` | Bash |
| `explore` | Read, Grep, Glob, LS, WebFetch, WebSearch, ToolSearch |
| `deleg` | Agent, Workflow, SendMessage, Task* |
> `src/parser.ts:40` (`categorize`)

---

## 트리 단계 용어

### 노드 (Node / TreeNode)
살아남은 레코드 하나. `Q`(사용자 질문) 또는 `A`(AI 응답) 타입을 갖습니다. 아직 사람이 읽는 단위가 아니라 **원본에 가까운 알갱이**입니다.
> `src/types.ts:13`

### 포크 (Fork)
서브에이전트 실행 기록. 부모 세션과 **다른 파일**(`<세션UUID>/subagents/agent-*.jsonl`)에 저장됩니다. 파일 첫 줄의 `fork-context-ref`에 "부모 세션의 어느 uuid에서 갈라졌는지"가 들어 있어서, 그 지점에 포크의 뿌리를 접붙여 **별개 파일을 한 트리의 가지로** 만듭니다. 화면에서는 보라색 라벨로 표시됩니다.
> `src/tree.ts:83`, `src/discover.ts:93` (`listForkFiles`)

### 압축 경계 (compact boundary)
Claude Code가 컨텍스트를 압축한 시점. `type: "system", subtype: "compact_boundary"` 레코드로 기록되며, 화면에서는 두 턴 사이에 `⑊` 마커로 표시됩니다.
> `src/parser.ts:124`, `src/turns.ts:78` (`linkGaps`)

---

## 턴 단계 용어

### 턴 (Turn)
**이 프로젝트의 핵심 단위.** "사용자 질문 하나 + 그 뒤 AI가 다음 질문까지 한 일 전부"를 한 덩어리로 접은 것입니다. 노드를 그대로 그리면 너무 잘게 쪼개져서 읽히지 않기 때문입니다.

접을 때 **진짜 분기점(되돌리기, 포크)은 접지 않고 가지로 남깁니다.** 이 점이 평평한 타임라인과 결정적으로 다릅니다.
> `src/turns.ts:54` (`collapse`), `src/types.ts:31`

### phase (턴의 성격)
턴에 색을 입히는 기준. "가장 무거운 작업"을 따릅니다: 편집이 하나라도 있으면 `edit`, 없으면 `exec` → `explore` → `chat` 순.

| phase | 화면 표기 | 색 |
|---|---|---|
| `edit` | 편집 | 파랑 |
| `exec` | 실행 | 초록 |
| `explore` | 탐색 | 연두 |
| `chat` | 대화 | 회색 |
> `src/turns.ts:9` (`phaseOf`)

### 레인 (Lane)
노선도의 가로줄. 첫째 자식은 부모의 레인을 그대로 물려받고, 둘째부터 새 레인을 받습니다. 그래서 되돌리기가 있던 지점에서 선이 갈라져 보입니다.
> `public/index.html:416` (`assign`)

### 씨앗 마커 (seam)
두 턴 사이의 점선 캡슐. 시간 공백(`⋯1.6h`, 30분 이상일 때만)과 압축 경계(`⑊`)를 표시합니다.
> `public/index.html:452`, `src/turns.ts:78`

---

## 압축 패키지 용어

### 압축 패키지 (Compaction package)
사용자가 `shift+클릭`으로 고른 **턴 구간**을, 다른 대화나 다른 AI가 이어받을 수 있는 인수인계 문서로 만든 것. `.md`와 `.json` 두 벌로 `packages/` 아래에 저장됩니다.
> `src/server.ts:78` (`handleCompact`)

### 사실층 / 요약층
압축 패키지가 두 층으로 나뉘어 있다는 것이 설계의 핵심입니다.

- **사실층** — 만진 파일, 실행한 명령, 에러 턴, 토큰 수, 원문 uuid 앵커. **코드가 직접 계산**하므로 환각이 낄 수 없습니다.
- **요약층** — 목표, 서사, 결정과 근거, 완료/미완, 열린 스레드, 함정. `claude -p` 서브프로세스가 생성합니다.
> `src/server.ts:102` (`facts`), `src/server.ts:115` (요약 프롬프트)

### 원문 앵커 (anchor)
요약이 어느 원본 턴에서 나왔는지 되짚을 수 있도록 압축 패키지 끝에 붙는 `시각 · uuid · 헤드라인` 목록.
> `src/server.ts:110`
