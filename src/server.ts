import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { exec, spawn } from 'node:child_process';
import { listProjects } from './discover';
import { buildForest } from './tree';
import { buildTurnForest } from './turns';
import { renderTranscript } from './transcript';
import { buildCompactPrompt, parseSummary, COMPACT_SYSTEM_PROMPT } from './prompt';
import { Turn } from './types';

const PORT = Number(process.env.PORT) || 4300;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PKG_ROOT = path.join(__dirname, '..', 'packages');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cross-Origin-Resource-Policy': 'same-origin' });
  res.end(body);
}

function serveStatic(reqPath: string, res: http.ServerResponse) {
  const rel = reqPath === '/' ? '/index.html' : reqPath;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

function readBody(req: http.IncomingMessage, res: http.ServerResponse, limit: number, onJson: (body: any) => void) {
  if (req.headers['x-branchport'] !== '1') { res.writeHead(403); res.end(); return; }
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > limit) { res.writeHead(413); res.end(); req.destroy(); }
  });
  req.on('end', () => {
    try { onJson(JSON.parse(body)); }
    catch (e: any) { sendJson(res, 400, { error: String(e?.message ?? e) }); }
  });
}

// --output-format json 래퍼에서 뽑은 호출 계측값 (평가 지표 §4.1 비용·절감률 산정용)
interface ClaudeMetrics {
  costUsd: number | null;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  durationMs: number | null;
  durationApiMs: number | null;
  numTurns: number | null;
}

// compact 호출에 쓸 수 있는 모델 별칭 — A/B 측정용. 그 외 값은 무시하고 CLI 기본값 사용.
const ALLOWED_MODELS = new Set(['sonnet', 'opus', 'haiku']);

function askClaude(prompt: string, model: string | undefined, onDone: (out: string, err: string, code: number | null, metrics: ClaudeMetrics | null) => void) {
  // --system-prompt: 운영자 전역 CLAUDE.md(언어 지시 등)가 요약을 오염시키지 않도록
  //   기본 시스템 프롬프트를 대체한다 (prompt.ts 주석 참고).
  // --tools "": compact는 도구 금지 작업이므로 도구 정의를 프롬프트에서 제거해
  //   호출당 입력 토큰을 줄인다.
  const args = ['-p', '--output-format', 'json', '--system-prompt', COMPACT_SYSTEM_PROMPT, '--tools', ''];
  if (model && ALLOWED_MODELS.has(model)) args.push('--model', model);
  const child = spawn('claude', args, { cwd: os.tmpdir() });
  let out = '', err = '', done = false;
  const finish = (o: string, e: string, c: number | null) => {
    if (done) return;
    done = true;
    // stdout은 {result, usage, total_cost_usd, ...} 래퍼 — 파싱 실패 시 원문 그대로 폴백
    let text = o, metrics: ClaudeMetrics | null = null;
    try {
      const w = JSON.parse(o);
      if (w && typeof w === 'object' && typeof w.result === 'string') {
        text = w.result;
        const u = w.usage ?? {};
        metrics = {
          costUsd: typeof w.total_cost_usd === 'number' ? w.total_cost_usd : null,
          inputTokens: u.input_tokens ?? 0,
          cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          durationMs: typeof w.duration_ms === 'number' ? w.duration_ms : null,
          durationApiMs: typeof w.duration_api_ms === 'number' ? w.duration_api_ms : null,
          numTurns: typeof w.num_turns === 'number' ? w.num_turns : null,
        };
        if (w.is_error) e = e || text.slice(0, 500);
      }
    } catch {}
    onDone(text, e, c, metrics);
  };
  const timer = setTimeout(() => child.kill(), 420_000);
  child.on('error', (e) => { clearTimeout(timer); finish('', 'claude 실행 불가: ' + String((e as any)?.message ?? e), null); });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('close', (code) => { clearTimeout(timer); finish(out, err, code); });
  child.stdin.on('error', () => {});
  child.stdin.write(prompt);
  child.stdin.end();
}

function flattenTurns(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  const walk = (ts: Turn[]) => { for (const t of ts) { out.push(t); walk(t.children); } };
  walk(turns);
  return out;
}

// 103세션 실측(sweep-v34 + fable5): 트랜스크립트가 이 미만이면 패키지 고정비
// (사실층·앵커·섹션 골격) 때문에 원문보다 커진다 — 잔존율 168% 역효과 구간.
const COMPACT_MIN_CHARS = 5000;

async function resolveRange(project: string, turnIds: string[]) {
  const forest = await buildForest(project);
  const allTurns = flattenTurns(buildTurnForest(forest.roots, forest.compactBoundaries));
  const byId = new Map(allTurns.map(t => [t.id, t]));
  const range = turnIds.map((id: string) => byId.get(id)).filter((t: Turn | undefined): t is Turn => !!t)
    .sort((a: Turn, b: Turn) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  return { forest, range };
}

// 압축 실행 전 구간 크기 견적 — UI가 손익분기 미만 구간을 경고할 수 있게 한다.
function handleEstimate(req: http.IncomingMessage, res: http.ServerResponse) {
  readBody(req, res, 10_000, async ({ project, turnIds }) => {
    if (!project || !Array.isArray(turnIds) || !turnIds.length) {
      return sendJson(res, 400, { error: 'project와 turnIds가 필요합니다' });
    }
    try {
      const { forest, range } = await resolveRange(project, turnIds);
      if (!range.length) return sendJson(res, 400, { error: '선택한 턴을 찾을 수 없습니다' });
      const transcript = renderTranscript(range, forest.roots, forest.toolResults);
      sendJson(res, 200, {
        transcriptChars: transcript.length,
        threshold: COMPACT_MIN_CHARS,
        belowThreshold: transcript.length < COMPACT_MIN_CHARS,
      });
    } catch (e: any) {
      sendJson(res, 500, { error: String(e?.message ?? e) });
    }
  });
}

function handleCompact(req: http.IncomingMessage, res: http.ServerResponse) {
  readBody(req, res, 10_000, async ({ project, turnIds, model }) => {
    if (!project || !Array.isArray(turnIds) || !turnIds.length) {
      return sendJson(res, 400, { error: 'project와 turnIds가 필요합니다' });
    }
    const { forest, range } = await resolveRange(project, turnIds);
    if (!range.length) return sendJson(res, 400, { error: '선택한 턴을 찾을 수 없습니다' });

    const fileCount = new Map<string, number>();
    const cmds = new Set<string>();
    const errorTurns: string[] = [], delegatedTurns: string[] = [];
    let tokens = 0, toolCalls = 0;
    for (const t of range) {
      for (const f of t.files) fileCount.set(f, (fileCount.get(f) || 0) + 1);
      for (const tc of t.tools) if (tc.category === 'exec' && tc.name === 'Bash') cmds.add(tc.inputPreview);
      if (t.hasError) errorTurns.push(t.headline);
      if (t.delegated) delegatedTurns.push(t.headline);
      tokens += t.outputTokens;
      toolCalls += t.toolCount;
    }
    const facts = {
      project, turnCount: range.length,
      period: [range[0].timestamp, range[range.length - 1].endTimestamp],
      files: [...fileCount.entries()].sort((x, y) => y[1] - x[1]).map(([f, n]) => `${f}(${n})`),
      commands: [...cmds].slice(0, 20),
      errorTurns, delegatedTurns,
      outputTokens: tokens, toolCalls,
    };
    const anchors = range.map(t => ({ id: t.id, ts: t.timestamp, headline: t.headline }));

    const transcript = renderTranscript(range, forest.roots, forest.toolResults);
    const prompt = buildCompactPrompt(transcript);

    // 스윕 실측: 드물게(106회 중 3회) 응답 JSON이 중간에서 끊긴다 — 일시적 절단이라
    // 재실행이면 통과하므로, 모델이 실행됐는데 파싱만 실패한 경우 1회 자동 재시도한다.
    const runCompact = (attempt: number) => askClaude(prompt, typeof model === 'string' ? model : undefined, (out, err, code, metrics) => {
      try {
        const S = parseSummary(out);
        if (!S) {
          if (attempt === 1 && code !== null && out.trim()) {
            console.warn('[compact] 응답 파싱 실패 (절단 추정) — 1회 재시도');
            return runCompact(2);
          }
          const why = !out.trim()
            ? (code === null ? '시간 초과 또는 claude 실행 불가: ' + err.slice(0, 200) : 'claude 실행 실패: ' + err.slice(0, 200))
            : '응답이 JSON 형식이 아님: ' + out.slice(0, 200);
          console.error(`[compact 실패] ${why}`);
          return sendJson(res, 502, { error: why });
        }
        const md = [
          `# 압축 패키지 — ${range.length}턴`,
          `> 프로젝트 ${facts.project} · ${(facts.period[0] ?? '').slice(0, 16)} → ${(facts.period[1] ?? '').slice(11, 16)}`,
          ``, `## 목표`, S.goal || '-',
          ``, `## 요약`, S.summary || '-',
          ``, `## 결정사항`, ...(S.decisions.length ? S.decisions.map(d => `- **${d.d || '-'}** — ${d.why || '-'}`) : ['- (없음)']),
          ``, `## 상태`,
          `- 완료: ${S.state.done.join(' / ') || '-'}`,
          `- 미완: ${S.state.todo.join(' / ') || '-'}`,
          `- **현재 초점**: ${S.state.current_focus || '(종결됨)'}`,
          ``, `## 에러와 해결`, ...(S.errors.length ? S.errors.map(e => `- ${e.error || '-'} → ${e.fix || '-'}`) : ['- (없음)']),
          ``, `## 사용자 제약 (계속 유효)`, ...(S.constraints.length ? S.constraints.map(c => `- ${c}`) : ['- (없음)']),
          ``, `## 환경`, ...(S.env.length ? S.env.map(e => `- ${e}`) : ['- (없음)']),
          ``, `## 열린 스레드`, ...(S.open_threads.length ? S.open_threads.map(x => `- ${x}`) : ['- (없음)']),
          ``, `## 주의`, ...(S.gotchas.length ? S.gotchas.map(x => `- ${x}`) : ['- (없음)']),
          ``, `## 사실층`,
          `- 만진 파일: ${facts.files.join(', ') || '-'}`,
          `- 실행 명령: ${facts.commands.length ? facts.commands.map(c => `\`${c}\``).join(', ') : '-'}`,
          `- 에러 턴: ${facts.errorTurns.join(', ') || '없음'} · 위임 턴: ${facts.delegatedTurns.join(', ') || '없음'}`,
          `- 도구 ${facts.toolCalls}회 · 출력 토큰(청구 기준) ${facts.outputTokens.toLocaleString()}`,
          ...(metrics ? [
            `- 압축 호출: ${metrics.costUsd != null ? '$' + metrics.costUsd.toFixed(4) : '비용 미상'} · 입력 토큰 ${(metrics.inputTokens + metrics.cacheCreationTokens + metrics.cacheReadTokens).toLocaleString()}(캐시 생성 ${metrics.cacheCreationTokens.toLocaleString()}·캐시 읽기 ${metrics.cacheReadTokens.toLocaleString()}) · 출력 ${metrics.outputTokens.toLocaleString()} · ${metrics.durationMs != null ? Math.round(metrics.durationMs / 1000) + '초' : '시간 미상'}`,
          ] : []),
          ``, `## 원문 앵커`,
          ...anchors.map(x => `- ${(x.ts ?? '').slice(11, 19)} · \`${x.id}\` — ${x.headline}`),
        ].join('\n');
        const jsonPkg = { meta: { generated: new Date().toISOString(), transcriptChars: transcript.length, promptChars: prompt.length, model: typeof model === 'string' && ALLOWED_MODELS.has(model) ? model : 'default', attempts: attempt, claude: metrics }, facts, summary: S, anchors };
        if (metrics) console.log(`[compact 계측] 비용 ${metrics.costUsd != null ? '$' + metrics.costUsd.toFixed(4) : '?'} · 입력 ${metrics.inputTokens}(캐시생성 ${metrics.cacheCreationTokens}/캐시읽기 ${metrics.cacheReadTokens}) · 출력 ${metrics.outputTokens} · ${metrics.durationMs ?? '?'}ms (API ${metrics.durationApiMs ?? '?'}ms)`);

        const pkgDir = path.join(PKG_ROOT, project);
        fs.mkdirSync(pkgDir, { recursive: true });
        const base = `pkg-${Date.now()}`;
        fs.writeFileSync(path.join(pkgDir, base + '.md'), md);
        fs.writeFileSync(path.join(pkgDir, base + '.json'), JSON.stringify(jsonPkg, null, 1));
        sendJson(res, 200, { md, json: jsonPkg, pkgFile: base, savedTo: path.join('packages', project, base + '.md') });
      } catch (e: any) {
        console.error('[compact 조립 실패]', e?.message);
        sendJson(res, 500, { error: '패키지 조립 실패: ' + String(e?.message ?? e) });
      }
    });
    runCompact(1);
  });
}

const server = http.createServer((req, res) => {
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) {
    res.writeHead(403); res.end(); return;
  }

  if (req.method === 'POST' && req.url === '/api/compact') return handleCompact(req, res);
  if (req.method === 'POST' && req.url === '/api/compact/estimate') return handleEstimate(req, res);

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (url.pathname === '/api/projects') {
    return sendJson(res, 200, listProjects());
  }

  if (url.pathname === '/api/tree') {
    const project = url.searchParams.get('project');
    if (!project) return sendJson(res, 400, { error: 'missing ?project=' });
    return buildForest(project)
      .then(forest => sendJson(res, 200, forest))
      .catch((e: any) => sendJson(res, 500, { error: e?.message ?? String(e) }));
  }

  if (url.pathname === '/api/turns') {
    const project = url.searchParams.get('project');
    if (!project) return sendJson(res, 400, { error: 'missing ?project=' });
    return buildForest(project)
      .then(forest => sendJson(res, 200, {
        turns: buildTurnForest(forest.roots, forest.compactBoundaries),
        stats: forest.stats,
      }))
      .catch((e: any) => sendJson(res, 500, { error: e?.message ?? String(e) }));
  }

  return serveStatic(url.pathname, res);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`BranchPort running at ${url}`);
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  exec(`${opener} ${url}`, () => {});
});
