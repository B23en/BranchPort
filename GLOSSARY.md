# GLOSSARY.md

BranchPort 코드베이스에서 쓰는 용어를 정의하는 문서입니다.

이 프로젝트는 **같은 대상을 단계마다 다른 이름으로 부르기 때문에**, 용어를 모르면 코드가 읽히지 않습니다. 여기서 팀이 쓰는 이름을 하나로 맞춥니다.

> 정의 근거와 조사 과정은 [오픈소스/조사_GLOSSARY_용어정립_방법.md](./오픈소스/조사_GLOSSARY_용어정립_방법.md) 참조.
> 층 구분 원칙: **fork = 원래 세션에서 분기시키는 행위, branch = fork로 인해 생긴 새로운 세션.** 행위와 결과물을 구분한다.

---

## session (세션)

Claude Code가 프로젝트 디렉터리별로 저장하는 대화 기록 하나. `~/.claude/projects/<프로젝트>/<session-id>.jsonl` 파일 하나가 세션 하나이며, 코드에서는 `SessionRef`(`src/types.ts`)로 가리킨다.

- **공식 정의 차용**: Claude Code 공식 문서(sessions)의 정의를 그대로 쓴다.
- **관련 용어**: transcript — 세션의 물리적 JSONL 파일 자체를 가리키는 공식 명칭. 파일을 강조할 때만 쓴다.
- **쓰지 않는 표현**: "대화", "conversation" — 항상 session.

## record (레코드)

JSONL 파일의 원시 한 줄. 실측상 약 70%는 attachment·ai-title·queue-operation 같은 메타 타입이라 파서(`src/parser.ts`)가 걸러낸다.

- **이것이 아님**: node가 아니다 — node는 필터를 통과해 트리에 남은 레코드다.

## node (노드)

필터를 통과해 트리에 들어온 원시 메시지 하나. `src/types.ts`의 `TreeNode` 타입에 대응하며, type은 `'Q'`(user 메시지) 또는 `'A'`(assistant 메시지)다.

- **이것이 아님**: turn이 아니다 — turn은 여러 node를 접어 만든 상위 단위다.
- **쓰지 않는 표현**: "메시지" — 파싱 전에는 record, 트리에 들어온 뒤에는 항상 node.

## turn (턴)

사용자 프롬프트 하나와 그에 대한 응답·도구 작업 전체를 묶은 **화면 기본 표시 단위**. `src/types.ts`의 `Turn` 타입이며, `src/turns.ts`의 collapse가 node 체인을 접어 만든다.

- **프로젝트 자체 정의임을 선언한다.** Claude Agent SDK의 turn(도구 호출 왕복 1회)과 다르다 — SDK 기준으로는 우리 turn 하나에 여러 SDK-turn이 들어간다.
- 실측 근거: node 단위로는 세션 중앙값 161개·최대 1,007개지만, turn으로 접으면 10~80개가 되어 한 화면에 들어간다.
- **관련 용어**: [phase](#phase-페이즈) — 모든 turn은 phase 분류를 하나 가진다.
- **쓰지 않는 표현**: "메시지 쌍", "교환" — 항상 turn.

## fork (포크)

원래 세션에서 **분기시키는 행위 자체**. 서브에이전트 스폰(기록이 `subagents/agent-<agentId>.jsonl`로 갈라짐)과 세션 사본 생성(`--fork-session`, `/branch`)이 모두 fork에 해당한다. 코드에서는 fork가 일어난 지점을 `fork-context-ref` 레코드로 찾아 부모 세션에 이어 붙이고, 진입 turn에 `isForkRoot`·`forkName`을 표시한다(`src/tree.ts`).

- **이것이 아님**: fork의 **결과물**(갈라져 나간 새 세션)이 아니다 — 그것은 [branch](#branch-브랜치)다. 행위 = fork, 결과물 = branch.
- **관련 용어**: sidechain — JSONL의 `isSidechain` 필드에서 유래한 커뮤니티 관용어. 서브에이전트 fork로 생긴 branch를 가리키지만, 우리는 이 단어를 쓰지 않는다.

## branch (브랜치)

**fork로 인해 생긴 새로운 세션**(결과물). 현재 데이터에서는 서브에이전트 기록 파일(`subagents/agent-*.jsonl`)이 대표 사례이며, `--fork-session`으로 만들어진 세션 사본도 branch다. 트리에서는 fork 지점(`isForkRoot`)에서 갈라져 나간 경로로 나타난다.

- **이것이 아님**: git branch가 아니다. 코드 식별자로도 쓰지 않는다 — 코드에서 분기 관련 식별자는 fork 계열(`isForkRoot`, `forkName`, `forkRoots`)로 통일한다.
- 실측 근거 (2026-08-05 재검증): 로컬 46개 세션 전수 스캔 결과 **파일 안의 진짜 대화 분기는 0건** — 이전 조사의 "세션당 0~3개 분기"는 병렬 도구 호출 잡음(assistant 형제)으로 판명됐다. 현재 데이터에서 branch는 **fork로만 생긴다**. 되돌리기·재시도가 파일 안 형제 분기를 만드는지는 실사용 예가 없어 미확인.

## lane (레인)

노선도 렌더링에서 한 경로가 차지하는 세로 열. `public/index.html`의 렌더링 개념이며 데이터 모델(`src/types.ts`)에는 존재하지 않는다.

- **관련 용어**: 지하철 노선도 은유의 line(노선)에 대응하는 구현 개념.

## phase (페이즈)

turn의 성격 분류: `edit`(파일 수정) / `exec`(명령 실행) / `explore`(탐색) / `chat`(대화만). `src/types.ts`의 `Phase` 타입이며, turn에 포함된 도구 호출의 종류로 결정된다.

## compact 경계 (compact boundary)

`/compact`로 이전 히스토리가 요약으로 교체된 지점. 파서가 `compactBoundaries`로 수집하고 turn의 `compactBefore` 플래그로 표시한다.

- 공식 이벤트명은 `compact_boundary`(Agent SDK). 시각화에서 구간 경계 1순위 신호로 쓴다.

---

## 운영 원칙

- 새 개념이 코드에 들어오면 이 문서에 등재하는 것을 PR 체크 항목으로 삼는다.
- 정의가 코드와 어긋나면 **불일치 자체를 버그로 취급**하고, 문서와 코드 중 어느 쪽을 고칠지 결정한다.
