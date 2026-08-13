import * as fs from 'node:fs';
import * as path from 'node:path';
import { Turn } from './types';
import { identTokens, phraseTokens } from './glossary';

// ── 검색 인덱스 + 로그 네이티브 그래프 검색 ─────────────────────────────────
// 인덱스 재료는 전부 기존 산출물: 라벨(제목·요약) + 턴 메타(files) + 식별자
// (glossary.identTokens — 원문에서 기계 추출). LLM 호출 0회.
// 점수화는 8/10 실측(PoC 2회)에서 확정된 처방을 그대로 구현한다:
//  ① 시드 IDF 가중 — "질문"·"에이전트" 같은 흔한 단어의 시드 팽창(실측 37~63개) 억제
//  ② 다중 키워드 동시 매치 부스트
//  ③ 확산은 상위 시드에서만, 엣지당 1/√df 감쇠 + df 30% 가드 — 단순 1-hop의
//     과확장(19→156턴 실측) 억제. 1/√df는 엣지당 감쇠라 총 전파량은 √df로 늘 수
//     있으므로(BM25류 절충), 허브 차단은 df 가드가 담당한다.

export interface SearchHit {
  id: string;
  ts: string | null;
  sessionId: string;
  title: string;
  gist: string;
  files: string[];
  score: number;
  via: 'direct' | 'graph'; // graph = 키워드 매치 없이 연결로 회수된 턴
}

interface Entry {
  t: Turn;
  title: string;
  gist: string;
  files: string[];
  idents: Set<string>;
  // 검색용 사전계산 — 쿼리마다 전체 원문을 재소문자화하지 않도록 빌드 시 1회만 만든다
  hay: string;         // 라벨(제목+요약) 소문자
  body: string;        // 원문(질문+응답 일부) 소문자 — 응답에만 있는 문구도 잡히게
  identsLower: Set<string>;
  filesLower: string[];
}

export interface SearchIndex {
  entries: Map<string, Entry>;
  fileIdx: Map<string, Set<string>>;
  tokIdx: Map<string, Set<string>>;
  adjacent: Map<string, string[]>; // 같은 세션 앞뒤 턴
  n: number;
}

export function buildSearchIndex(turns: Turn[], labels: Record<string, { t: string; g: string }>): SearchIndex {
  const entries = new Map<string, Entry>();
  const fileIdx = new Map<string, Set<string>>();
  const tokIdx = new Map<string, Set<string>>();
  for (const t of turns) {
    const lb = labels[t.hash];
    // 앞 6000자만 — 식별자는 대개 초반에 등장하고, 전량 스캔은 긴 턴에서 낭비.
    // phraseTokens(인용구·한글 개념어)도 편입 — 8/12 실측: LLM 추출 고유 엔티티의
    // 38%(20/53)를 이 기계 추출이 공짜로 회수한다 (chat 턴의 검색 가능성 개선)
    const body6k = (t.prompt + ' ' + t.answer).slice(0, 6000);
    const idents = new Set([...identTokens(body6k).keys(), ...phraseTokens(body6k).keys()]);
    const files = t.files.map(f => path.basename(f));
    const title = lb?.t ?? '', gist = lb?.g ?? '';
    entries.set(t.id, {
      t, title, gist, files, idents,
      hay: (title + ' ' + gist).toLowerCase(),
      // 800컷이 유일한 진짜 커버리지 실패(Q9)의 원인 — 답변 후반부 언급이 안 잡혔다.
      // 확산 상한(SPREAD_CAP_RATIO)과 세트 적용 필수 — 단독 적용은 노이즈만 증가
      // (컷만 늘리면 원점수가 커진 대형 턴의 확산이 오히려 더 세진다).
      body: (t.prompt.slice(0, 3000) + ' ' + t.answer.slice(0, 3000)).toLowerCase(), // 3,000 = 파서 저장 컷과 동일(사실상 저장 전량)
      identsLower: new Set([...idents].map(x => x.toLowerCase())),
      filesLower: files.map(f => f.toLowerCase()),
    });
    for (const f of files) {
      if (!fileIdx.has(f)) fileIdx.set(f, new Set());
      fileIdx.get(f)!.add(t.id);
    }
    for (const k of idents) {
      if (!tokIdx.has(k)) tokIdx.set(k, new Set());
      tokIdx.get(k)!.add(t.id);
    }
  }
  const bySess = new Map<string, Turn[]>();
  for (const t of turns) {
    if (!bySess.has(t.sessionId)) bySess.set(t.sessionId, []);
    bySess.get(t.sessionId)!.push(t);
  }
  const adjacent = new Map<string, string[]>();
  for (const arr of bySess.values()) {
    arr.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
    arr.forEach((t, i) => adjacent.set(t.id, [arr[i - 1]?.id, arr[i + 1]?.id].filter((x): x is string => !!x)));
  }
  return { entries, fileIdx, tokIdx, adjacent, n: turns.length };
}

const SEED_TOP = 8;      // 확산은 상위 시드에서만 — 약한 시드의 노이즈 전파 차단
const SPREAD_W = { file: 0.5, ident: 0.4, adjacent: 0.15 };
// 확산 기여 상한 비율 — 원점수가 정규화 안 된 채(최대 115점 실측) 이웃에 뿌려지면
// 무관 대형 턴의 이웃이 정답 직접매치(40점대)를 밀어낸다. 0.1~0.3 구간에서 결과
// 평평, 홀드아웃 60질의 실측(r@3 56.7%→96.7%, MRR 0.496→0.936, 본문 컷 확대와 세트).
const SPREAD_CAP_RATIO = 0.3;

// only: 후보를 이 턴 id 집합으로 한정 (갈래 대화의 조상 경로 한정 검색용 —
// IDF도 한정 집합 기준으로 계산돼 경로 안에서의 변별력이 올라간다)
export function searchIndex(idx: SearchIndex, query: string, topN = 10, only?: Set<string>): SearchHit[] {
  const kws = [...new Set(query.toLowerCase().split(/\s+/).filter(k => k.length >= 2))];
  if (!kws.length) return [];

  // 키워드별 매치 판정 (필드 가중은 실측 PoC와 동일: 식별자·파일 3 > 라벨 2 > 원문 1)
  const kwHits = kws.map(kw => {
    const hits = new Map<string, number>();
    for (const [id, e] of idx.entries) {
      if (only && !only.has(id)) continue;
      let w = 0;
      if (e.hay.includes(kw)) w = 2;
      if (w < 3 && (e.identsLower.has(kw) || e.filesLower.some(f => f.includes(kw)))) w = 3;
      if (w < 1 && e.body.includes(kw)) w = 1;
      if (w) hits.set(id, w);
    }
    return hits;
  });

  // 시드 점수 = Σ 필드가중 × IDF — 흔한 단어(df 큼)는 idf가 깎는다
  const seed = new Map<string, { score: number; matched: number }>();
  kwHits.forEach(hits => {
    if (!hits.size) return;
    const idf = Math.log(1 + idx.n / hits.size);
    for (const [id, w] of hits) {
      const s = seed.get(id) ?? { score: 0, matched: 0 };
      s.score += w * idf;
      s.matched++;
      seed.set(id, s);
    }
  });
  // 다중 키워드 동시 매치 부스트 — 흔한 단어 하나로는 상위에 못 온다
  const score = new Map<string, number>();
  for (const [id, s] of seed) score.set(id, s.matched >= 2 ? s.score * 1.4 : s.score);

  // 그래프 확산 — 상위 시드에서만, 1/√df 가중. 확산분은 score에 바로 합산하지 않고
  // spreadAcc에 모아뒀다가 아래에서 턴별 상한을 걸고 나서 합산한다 — 정규화 안 된
  // 원점수(시드 점수 s0)를 그대로 퍼뜨리면 대형 턴 하나가 자기 이웃 전체를 밀어올릴
  // 수 있기 때문(실측: 최대 115점 시드가 무관 이웃에 정답의 직접점수 40점대를 넘는
  // 확산을 뿌림).
  const topSeeds = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, SEED_TOP);
  const spreadAcc = new Map<string, number>();
  for (const [id, s0] of topSeeds) {
    const e = idx.entries.get(id)!;
    const give = (nid: string, w: number) => {
      if (nid === id) return;
      if (only && !only.has(nid)) return;
      spreadAcc.set(nid, (spreadAcc.get(nid) ?? 0) + s0 * w);
    };
    for (const f of e.files) {
      const peers = idx.fileIdx.get(f)!;
      // 식별자 확산과 동일한 df 가드 — 전체의 30%를 만진 파일은 변별력이 없다
      if (peers.size < 2 || peers.size > idx.n * 0.3) continue;
      const w = SPREAD_W.file / Math.sqrt(peers.size);
      for (const o of peers) give(o, w);
    }
    for (const k of e.idents) {
      const peers = idx.tokIdx.get(k);
      if (!peers || peers.size < 2 || peers.size > idx.n * 0.3) continue;
      const w = SPREAD_W.ident / Math.sqrt(peers.size);
      for (const o of peers) give(o, w);
    }
    for (const o of idx.adjacent.get(id) ?? []) give(o, SPREAD_W.adjacent);
  }
  // 상한은 "그 턴 자신의 직접 점수"가 아니라 "전체 최고 직접 점수 × 비율"로 건다 —
  // 확산을 받는 개별 이웃의 직접점수와 무관하게 확산 총량 자체를 억제하는 게 목적.
  const maxDirectScore = topSeeds.length ? topSeeds[0][1] : 0;
  const spreadCap = maxDirectScore * SPREAD_CAP_RATIO;
  for (const [id, acc] of spreadAcc) {
    score.set(id, (score.get(id) ?? 0) + Math.min(acc, spreadCap));
  }

  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([id, sc]) => {
      const e = idx.entries.get(id)!;
      return {
        id, ts: e.t.timestamp, sessionId: e.t.sessionId,
        title: e.title, gist: e.gist, files: e.files,
        score: Math.round(sc * 100) / 100,
        via: seed.has(id) ? 'direct' as const : 'graph' as const,
      };
    });
}

// 압축 동봉용: 범위 턴들을 시드로 확산해 "범위 밖에서 가장 강하게 연결된 턴"을 회수.
// 쿼리 없이 구조 연결(파일·식별자·인접)만 쓰므로 결정론이고, 검색과 같은 가드를 공유한다.
export function relatedToRange(idx: SearchIndex, rangeIds: Set<string>, topN = 6): SearchHit[] {
  const score = new Map<string, number>();
  for (const id of rangeIds) {
    const e = idx.entries.get(id);
    if (!e) continue;
    const give = (nid: string, w: number) => {
      if (!rangeIds.has(nid)) score.set(nid, (score.get(nid) ?? 0) + w);
    };
    for (const f of e.files) {
      const peers = idx.fileIdx.get(f)!;
      if (peers.size < 2 || peers.size > idx.n * 0.3) continue;
      const w = SPREAD_W.file / Math.sqrt(peers.size);
      for (const o of peers) give(o, w);
    }
    for (const k of e.idents) {
      const peers = idx.tokIdx.get(k);
      if (!peers || peers.size < 2 || peers.size > idx.n * 0.3) continue;
      const w = SPREAD_W.ident / Math.sqrt(peers.size);
      for (const o of peers) give(o, w);
    }
    for (const o of idx.adjacent.get(id) ?? []) give(o, SPREAD_W.adjacent);
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([id, sc]) => {
      const e = idx.entries.get(id)!;
      return {
        id, ts: e.t.timestamp, sessionId: e.t.sessionId,
        title: e.title, gist: e.gist, files: e.files,
        score: Math.round(sc * 100) / 100, via: 'graph' as const,
      };
    });
}

// 물질화 인덱스 — 서버 없이도 외부 도구(위키 export·grep)가 읽을 수 있는 산출물.
// labels/와 같은 파생 데이터 패턴, 실패해도 검색은 동작(부가층).
const INDEX_ROOT = path.join(__dirname, '..', 'index');

export function persistIndex(project: string, idx: SearchIndex) {
  fs.mkdirSync(INDEX_ROOT, { recursive: true });
  const rows = [...idx.entries.values()].map(e => ({
    id: e.t.id, ts: e.t.timestamp, session: e.t.sessionId,
    title: e.title, gist: e.gist, files: e.files, idents: [...e.idents].slice(0, 40),
  }));
  fs.writeFileSync(path.join(INDEX_ROOT, path.basename(project) + '.json'), JSON.stringify(rows, null, 1));
}
