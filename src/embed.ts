import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Turn } from './types';

// ── Ollama 임베딩 선택층 ─────────────────────────────────────────────────
// 서드파티 의존성 0(전역 fetch만 사용). Ollama가 없거나 느리면 예외·지연 없이
// null을 반환해 호출부가 키워드 검색으로 무손실 폴백하게 한다.
//
// 벡터 저장은 index/<프로젝트>.<모델태그>.vec.json에 턴 해시 키로 물질화 —
// search.ts의 기존 물질화 인덱스(persistIndex)와 같은 패턴. 모델명을 파일명에
// 섞는 이유: BP_EMBED_MODEL로 모델을 바꿔가며 비교 평가할 때 서로 다른 임베딩
// 공간의 벡터가 같은 파일에서 섞이면(차원이 같아도 의미 공간이 다름) 조용히
// 틀린 코사인 점수를 낸다 — 파일 자체를 분리해 원천 차단한다. 턴당 2벡터:
//   l(label)  = 라벨 제목+요약(없으면 headline) — 사람이 지은 요약 임베딩
//   b(body)   = prompt 1,000자 + answer 1,500자 — 원문 임베딩(라벨 탈락 보완)

const OLLAMA_BASE = process.env.BP_OLLAMA_BASE ?? 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.BP_EMBED_MODEL ?? 'bge-m3';
const PROBE_TIMEOUT_MS = 500;
const PROBE_CACHE_MS = 60_000;
const EMBED_BATCH = 32;
// 임베딩 요청 자체의 상한 — 프로브는 /api/version만 보므로 "Ollama는 살아 있는데
// 임베딩만 안 나오는" 상태(모델 로딩·다른 생성 작업 뒤 큐 대기·GPU 스톨)를 못 거른다.
// 이때 fetch에 상한이 없으면 검색 요청이 undici 기본값(300초)까지 멈춘다 — 실측 재현:
// /api/version만 답하고 /api/embed에 응답하지 않는 가짜 Ollama에 /api/search가 30초+
// 무응답. 상한을 걸면 abort → null → 키워드 폴백으로 수렴한다(모듈 계약: 지연 없는 폴백).
// 질의는 짧은 텍스트 1건이라 콜드 모델 로드(실측 0.9초)를 크게 잡아도 8초면 충분하고,
// 백그라운드 배치는 32건×장문이라 넉넉히 준다(느린 장비에서 색인이 통째로 실패하지 않게).
const QUERY_TIMEOUT_MS = 8_000;
const BATCH_TIMEOUT_MS = 120_000;

const INDEX_ROOT = path.join(__dirname, '..', 'index');

// ── 모델별 질의 prefix 정책 ─────────────────────────────────────────────
// qwen3-embedding 계열은 질의 측에만 instruct prefix가 필요하다(공식 문서: 미적용 시
// 1~5%p 하락). 문서(라벨·본문) 측엔 prefix를 붙이지 않는다 — 비대칭 인코딩이 이
// 모델 계열의 설계다. bge-m3는 prefix가 불필요(대칭 인코딩). BP_EMBED_MODEL을
// 바꾸면 이 정책도 자동으로 따라간다(모델명으로 분기하므로 별도 설정 불필요).
function needsQueryPrefix(model: string): boolean {
  return model.startsWith('qwen3-embedding');
}
function applyQueryPrefix(model: string, text: string): string {
  if (!needsQueryPrefix(model)) return text;
  return `Instruct: Given a Korean search query, retrieve relevant conversation turns\nQuery: ${text}`;
}

// ── 가용성 프로브 ───────────────────────────────────────────────────────
let probeCache: { ok: boolean; ts: number } | null = null;

export async function probeOllama(): Promise<boolean> {
  if (probeCache && Date.now() - probeCache.ts < PROBE_CACHE_MS) return probeCache.ok;
  let ok = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const r = await fetch(`${OLLAMA_BASE}/api/version`, { signal: ctrl.signal });
      ok = r.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    ok = false; // 타임아웃·연결거부·DNS 실패 등 전부 "가용하지 않음"으로 수렴
  }
  probeCache = { ok, ts: Date.now() };
  return ok;
}

// ── 배치 임베딩 ─────────────────────────────────────────────────────────
// kind: 'doc'(기본) = 라벨·본문 등 저장 대상, prefix 없음 / 'query' = 검색 질의,
// 모델이 요구하면 위 instruct prefix가 자동으로 붙는다.
export interface EmbedOpts { model?: string; kind?: 'doc' | 'query'; timeoutMs?: number; }

export async function embedTexts(texts: string[], opts?: EmbedOpts): Promise<Float32Array[] | null> {
  if (!texts.length) return [];
  if (!(await probeOllama())) return null;
  const model = opts?.model ?? EMBED_MODEL;
  const isQuery = opts?.kind === 'query';
  const timeoutMs = opts?.timeoutMs ?? (isQuery ? QUERY_TIMEOUT_MS : BATCH_TIMEOUT_MS);
  const input0 = isQuery ? texts.map(t => applyQueryPrefix(model, t)) : texts;
  try {
    const out: Float32Array[] = [];
    for (let i = 0; i < input0.length; i += EMBED_BATCH) {
      const batch = input0.slice(i, i + EMBED_BATCH);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs); // 배치마다 갱신 — 상한은 요청 1건 기준
      let j: any;
      try {
        const r = await fetch(`${OLLAMA_BASE}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: batch }),
          signal: ctrl.signal,
        });
        if (!r.ok) return null;
        j = await r.json(); // 본문 수신도 같은 상한 안에 둔다 (헤더만 오고 멈추는 경우 차단)
      } finally {
        clearTimeout(timer);
      }
      const embs = j?.embeddings;
      if (!Array.isArray(embs) || embs.length !== batch.length) return null;
      for (const e of embs) out.push(Float32Array.from(e));
    }
    return out;
  } catch {
    return null; // 배치 중간 실패 — 부분 결과는 신뢰할 수 없으므로 전체 null(호출부는 키워드로 폴백)
  }
}

// ── base64 <-> Float32Array ─────────────────────────────────────────────
function f32ToB64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}
function b64ToF32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  // Buffer가 공유 풀에서 4바이트 미정렬로 잘릴 수 있어, 정렬 보장을 위해 복사한다
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

// ── 벡터 저장소 ─────────────────────────────────────────────────────────
// lk = l벡터를 만들 때 쓴 라벨 텍스트의 지문. 라벨은 임베딩보다 늦게(비동기로) 붙는데
// 저장 키는 턴 해시(원문 기준)라 라벨이 생겨도 키가 그대로다 — 지문이 없으면 "라벨 없을
// 때 headline으로 만든 l벡터"가 영영 갱신되지 않는다(실측: 최근 턴 126건 중 14건이
// 현재 라벨 텍스트와 코사인 0.38~0.67, 즉 headline 벡터로 굳어 있었다).
interface VecEntry { l?: string; b?: string; lk?: string } // l·b는 base64
interface VecStore { model: string; dim: number; entries: Record<string, VecEntry>; }

// 파일명에 안전한 모델 태그 — ':' 등은 대부분 파일시스템에서 문제 없지만
// 이식성을 위해 영숫자·.·_·- 외 문자는 치환한다 (예: "qwen3-embedding:0.6b" → "qwen3-embedding-0.6b")
function safeModelTag(model: string): string {
  return model.replace(/[^A-Za-z0-9._-]/g, '-');
}

function vecFile(project: string, model: string): string {
  return path.join(INDEX_ROOT, path.basename(project) + '.' + safeModelTag(model) + '.vec.json');
}

function loadVecStore(project: string, model: string): VecStore {
  try {
    const raw = JSON.parse(fs.readFileSync(vecFile(project, model), 'utf8'));
    if (raw && typeof raw === 'object' && raw.entries) return raw;
  } catch { /* 없거나 손상 — 빈 저장소로 시작 */ }
  return { model, dim: 0, entries: {} };
}

function saveVecStore(project: string, model: string, store: VecStore) {
  fs.mkdirSync(INDEX_ROOT, { recursive: true });
  fs.writeFileSync(vecFile(project, model), JSON.stringify(store));
}

function labelText(t: Turn, lb?: { t: string; g: string }): string {
  return lb ? `${lb.t} — ${lb.g}` : t.headline;
}
function labelKey(text: string): string {
  return createHash('sha1').update(text).digest('base64').slice(0, 12);
}
function bodyText(t: Turn): string {
  return t.prompt.slice(0, 1000) + ' ' + t.answer.slice(0, 1500);
}

const ensureInFlight = new Set<string>();

// ── 증분 인덱싱 ─────────────────────────────────────────────────────────
// 저장소를 로드해 ① 벡터가 없는 턴 ② 벡터를 만든 뒤 라벨이 새로 붙거나 바뀐 턴(l만)을
// 임베딩하고 저장한다. Ollama가 죽어 있으면(embedTexts가 null 반환) 조용히 실패하고
// 기존 저장소를 그대로 둔다. model 생략 시 BP_EMBED_MODEL(기본 bge-m3).
export async function ensureVectors(
  project: string,
  turns: Turn[],
  labels: Record<string, { t: string; g: string }>,
  model: string = EMBED_MODEL,
): Promise<void> {
  // 같은 저장소에 대한 동시 실행 방지 — 호출부가 await 없이(fire-and-forget) 부르므로
  // 요청 2개가 겹치면 같은 턴을 두 번 임베딩하고 10MB 파일을 두 번 통째로 덮어쓴다.
  // (labelingInFlight와 같은 패턴. embedTexts에 요청 상한이 있어 잠금이 남지 않는다.)
  const lock = project + '|' + model;
  if (ensureInFlight.has(lock)) return;
  ensureInFlight.add(lock);
  try {
    const store = loadVecStore(project, model);
    // 파일 자체가 모델별로 분리돼 있으므로 정상적으로는 항상 일치한다 — 손상된 파일을
    // 손으로 옮겨 심었을 때 등의 방어선으로만 남겨둔다.
    if (store.model !== model) { store.entries = {}; store.model = model; store.dim = 0; }

    // 텍스트 1건 = 슬롯 1개. l만 다시 만들면 되는 턴은 b를 재임베딩하지 않는다.
    const texts: string[] = [];
    const slots: { hash: string; kind: 'l' | 'b'; lk: string }[] = [];
    for (const t of turns) {
      const e = store.entries[t.hash];
      const lt = labelText(t, labels[t.hash]);
      const lk = labelKey(lt);
      if (!e?.l || e.lk !== lk) { texts.push(lt); slots.push({ hash: t.hash, kind: 'l', lk }); }
      if (!e?.b) { texts.push(bodyText(t)); slots.push({ hash: t.hash, kind: 'b', lk }); }
    }
    if (!texts.length) return;

    const vecs = await embedTexts(texts, { model, kind: 'doc' });
    if (!vecs || vecs.length !== texts.length) return; // Ollama 부재/실패 — 저장소 변경 없이 반환(호출부는 키워드-only로 계속 동작)

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const e = store.entries[s.hash] ?? (store.entries[s.hash] = {});
      e[s.kind] = f32ToB64(vecs[i]);
      if (s.kind === 'l') e.lk = s.lk;
      if (!store.dim) store.dim = vecs[i].length;
    }
    try { saveVecStore(project, model, store); }
    catch (e: any) { console.error('[embed 저장 실패 — 다음 요청에서 재시도]', e?.message); }
  } finally {
    ensureInFlight.delete(lock);
  }
}

// ── 시맨틱 랭킹 ─────────────────────────────────────────────────────────
// 질의를 1회 임베딩하고, 각 턴에 대해 max(cos(질의, l), cos(질의, b))로 점수를 매긴다.
// only가 주어지면 그 턴 id 집합으로만 한정(갈래 조상 발췌 등 범위 한정 검색용).
// Ollama 부재/실패/벡터 없음이면 null — 호출부는 이를 "시맨틱 불가"로 보고 키워드로 폴백.
// model 생략 시 BP_EMBED_MODEL — 질의 임베딩에는 모델별 prefix 정책이 자동 적용된다.
export async function semanticRank(
  project: string,
  query: string,
  turnList: Turn[],
  only?: Set<string>,
  model: string = EMBED_MODEL,
): Promise<{ id: string; score: number }[] | null> {
  const store = loadVecStore(project, model);
  if (store.model !== model || !Object.keys(store.entries).length) return null;
  const qv = await embedTexts([query], { model, kind: 'query' });
  if (!qv || !qv[0]) return null;
  const q = qv[0];

  const out: { id: string; score: number }[] = [];
  for (const t of turnList) {
    if (only && !only.has(t.id)) continue;
    const e = store.entries[t.hash];
    if (!e) continue;
    let score = -Infinity;
    if (e.l) score = Math.max(score, cosine(q, b64ToF32(e.l)));
    if (e.b) score = Math.max(score, cosine(q, b64ToF32(e.b)));
    if (score > -Infinity) out.push({ id: t.id, score });
  }
  if (!out.length) return null;
  out.sort((a, b) => b.score - a.score);
  return out;
}
