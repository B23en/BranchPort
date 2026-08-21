// 압축 갈래 리트리버의 시점 격리 판정 — 순수 함수로 분리해 유닛 테스트 가능하게 한다.
//
// 왜 필요한가: 압축 갈래(branch-chat)는 지금까지 truncatePackage로 패키지 본문만 정적
// 승계했다. 패키지 범위(anchors) "이전"의 사실(조상 세션·범위 밖 결정)은 질문이 물어도
// 답할 길이 없었다 — 노드 갈래는 질문마다 조상 검색을 돌리는데 압축 갈래만 빠져 있던
// 비대칭. 이 함수는 그 검색의 후보군(= 범위 이전이면서 범위 밖인 턴)만 골라낸다.
//
// 시점 격리 기준: anchors[]의 최대 timestamp **이하**이면서 anchors[] 안에 없는 턴만
// 후보다. 범위(anchors) 자체는 이미 압축 md 본문에 있으니 제외하고, 범위 이후(=아직
// 압축 갈래가 몰라야 하는 미래)는 격리를 위해 배제한다. anchors가 비어 있으면(옛 패키지
// — 이 필드가 생기기 전에 만들어짐) 아예 빈 후보를 반환해 리트리버를 생략시킨다 — 종전
// truncatePackage 단독 동작으로 안전하게 폴백.
export interface RetrievalAnchor { id: string; ts: string | null }
export interface RetrievalTurn { id: string; timestamp: string | null; prompt: string; answer: string }

export function compactRetrievalCandidates(
  anchors: RetrievalAnchor[],
  turns: RetrievalTurn[],
): Set<string> {
  const out = new Set<string>();
  if (!anchors.length) return out;
  const maxTs = anchors.reduce((m, a) => (a.ts && a.ts > m ? a.ts : m), '');
  if (!maxTs) return out; // anchors에 ts가 하나도 없으면 판정 불가 — 안전 측(생략)
  const inRange = new Set(anchors.map(a => a.id));
  for (const t of turns) {
    if (!t.timestamp || t.timestamp > maxTs) continue; // 범위 이후 — 시점 격리 위반이라 배제
    if (inRange.has(t.id)) continue; // 범위 안 — 이미 md 본문에 있음
    if (t.prompt === '(계속)') continue; // 노드 갈래 조상 필터와 동일 기준
    if ((t.prompt + t.answer).length <= 400) continue;
    out.add(t.id);
  }
  return out;
}
