import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { ToolCall, ToolCategory, ParseStats } from './types';

const META_TYPES = new Set([
  'last-prompt', 'mode', 'permission-mode', 'attachment',
  'file-history-snapshot', 'file-history-delta', 'ai-title',
  'agent-name', 'bridge-session',
]);

// Claude Code stores hook output, hook hand-offs, and hand-injected reminders as
// type:"user" too. Rendering those as real turns fills the tree with noise, so
// anything starting with one of these gets excluded even when it carries text.
const FAKE_PREFIXES = [
  '[Request interrupted', '<command-name>', '<task-notification>', '<local-command-stdout>',
  '<local-command-stderr>', '<system-reminder>', '<teammate-message', '<agent-message',
  '<bash-input>', '<bash-stdout>', '<bash-stderr>', '<command-message>', '<command-args>',
  '<user-prompt-submit-hook>', '다음은 한 AI 코딩 세션에서', 'Another Claude session sent',
];

// Real API keys/tokens have shown up verbatim in session logs — these must never
// reach a preview, a saved compaction package, or the browser.
const SECRET_RE = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g, /sk-[A-Za-z0-9_-]{20,}/g, /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /AKIA[0-9A-Z]{16}/g, /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
];

function sanitize(s: string): string {
  if (!s) return s;
  let out = s.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  for (const re of SECRET_RE) out = out.replace(re, '•••masked•••');
  return out;
}

const EDIT_RE = /^(Edit|Write|NotebookEdit)$/;
const DELEG_RE = /^(Agent|Workflow|SendMessage|Task[A-Z][A-Za-z]*)$/;
const READ_RE = /^(Read|Grep|Glob|LS|WebFetch|WebSearch|ToolSearch)$/;

function categorize(name: string): ToolCategory {
  if (EDIT_RE.test(name)) return 'edit';
  if (DELEG_RE.test(name)) return 'deleg';
  if (name === 'Bash') return 'exec';
  if (READ_RE.test(name)) return 'explore';
  return 'other';
}

export interface ForkContextRef {
  agentId: string;
  parentSessionId: string;
  parentLastUuid: string;
}

export interface ParsedFile {
  sessionId: string;
  allParent: Map<string, string | null>;
  kind: Map<string, 'Q' | 'A'>;
  preview: Map<string, string>;
  text: Map<string, string>;
  timestamp: Map<string, string | null>;
  toolsByOwner: Map<string, ToolCall[]>;
  toolsByUseId: Map<string, ToolCall>;
  outputTokens: Map<string, number>;
  hasImage: Map<string, boolean>;
  interrupted: Map<string, boolean>;
  compactBoundaries: string[];
  forkContextRef: ForkContextRef | null;
  // 작업 중 끼어든 사용자 메시지 — queue-operation 레코드는 uuid가 없어 체인에
  // 못 들어가지만 진짜 사용자 텍스트라, 버리면 해당 턴이 "(계속)"으로 남는다.
  queuedPrompts: { ts: string; text: string }[];
  stats: ParseStats;
}

function truncate(s: string, n = 60): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n) + '…' : clean;
}

function isFakePrompt(text: string): boolean {
  const t = text.trim();
  // 제네릭 태그 규칙: 시스템 주입 텍스트는 전부 <하이픈-포함-태그>로 시작한다
  // (task-notification, system-reminder, bash-input …). 하이픈을 요구하는 이유:
  // 사용자가 <div> 같은 HTML을 붙여넣으며 질문하는 경우를 오분류하지 않기 위해.
  if (/^<[a-z]+(-[a-z]+)+[\s>]/.test(t)) return true;
  return FAKE_PREFIXES.some(p => t.startsWith(p));
}

export async function parseSessionFile(filePath: string, sessionId: string): Promise<ParsedFile> {
  const result: ParsedFile = {
    sessionId,
    allParent: new Map(),
    kind: new Map(),
    preview: new Map(),
    text: new Map(),
    timestamp: new Map(),
    toolsByOwner: new Map(),
    toolsByUseId: new Map(),
    outputTokens: new Map(),
    hasImage: new Map(),
    interrupted: new Map(),
    compactBoundaries: [],
    forkContextRef: null,
    queuedPrompts: [],
    stats: { totalLines: 0, parseErrors: 0, keptNodes: 0 },
  };

  // 아직 전송 확정(dequeue) 전인 큐 항목들 — 파일 끝까지 남으면 미전송이므로 버려진다
  const pendingQueue: { ts: string; text: string; fake: boolean }[] = [];
  let queueUntrusted = false; // content 없는 remove를 만난 뒤에는 짝맞춤을 믿지 않는다

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    result.stats.totalLines++;

    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      result.stats.parseErrors++;
      continue;
    }

    if (d.type === 'fork-context-ref') {
      result.forkContextRef = {
        agentId: d.agentId,
        parentSessionId: d.parentSessionId,
        parentLastUuid: d.parentLastUuid,
      };
      continue;
    }

    if (d.type === 'system' && d.subtype === 'compact_boundary' && d.timestamp) {
      result.compactBoundaries.push(d.timestamp);
      continue;
    }

    if (d.type === 'queue-operation') {
      // enqueue=입력, dequeue=실제 전송 확정(FIFO, content 없음), remove=보내기 전 삭제.
      // 실측: dequeue된 것의 86%가 정식 질문이 되고 remove된 것은 0.3%뿐 —
      // enqueue만 믿고 복원하면 "쓰다가 지운 초안"을 질문으로 날조하게 된다.
      // 시스템 주입(가짜)도 큐 순서에는 참여시키되(fake 표시) 결과에는 안 넣는다 —
      // 안 그러면 dequeue가 엉뚱한 항목을 꺼내 짝이 밀린다.
      if (d.operation === 'enqueue' && typeof d.content === 'string' && d.timestamp) {
        const text = d.content.trim();
        pendingQueue.push({ ts: d.timestamp, text: sanitize(text), fake: !text || isFakePrompt(text) });
      } else if (d.operation === 'dequeue') {
        const q = pendingQueue.shift();
        if (q && !q.fake && !queueUntrusted) result.queuedPrompts.push({ ts: q.ts, text: q.text });
      } else if (d.operation === 'remove') {
        if (typeof d.content === 'string') {
          const key = sanitize(d.content.trim());
          const i = pendingQueue.findIndex(x => x.text === key);
          if (i >= 0) pendingQueue.splice(i, 1); // 전송 전 삭제 — 복원 대상 아님
        } else {
          // 실측: remove의 89%가 content 없음 — 무엇을 지웠는지 특정할 수 없다.
          // 여기서부터 이 파일의 큐 짝맞춤은 신뢰 불가 → 이후 복원을 중단한다.
          // (지운 초안을 질문으로 날조하는 것보다 "(계속)"으로 남기는 쪽을 택함)
          queueUntrusted = true;
        }
      }
      continue;
    }

    const uuid: string | undefined = d.uuid;
    if (!uuid) continue; // metadata lines without uuid can't participate in the chain

    result.allParent.set(uuid, d.parentUuid ?? null);

    if (META_TYPES.has(d.type) || d.type === 'system') continue;

    const msg = d.message ?? {};
    const role: string | undefined = msg.role;
    const content = msg.content;

    let hasText = false;
    let hasToolUse = false;
    let hasToolResult = false;
    let hasImage = false;
    let interrupted = false;
    let textFull = '';
    const tools: ToolCall[] = [];

    if (typeof content === 'string' && content.trim()) {
      hasText = true;
      textFull = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          hasText = true;
          textFull = textFull ? textFull + ' ' + block.text : block.text;
          if (block.text.startsWith('[Request interrupted')) interrupted = true;
        } else if (block.type === 'image') {
          hasImage = true;
        } else if (block.type === 'tool_use') {
          hasToolUse = true;
          const input = block.input ?? {};
          const filePath = typeof input.file_path === 'string' ? input.file_path.split('/').pop() ?? null : null;
          const detail = filePath || (typeof input.command === 'string' ? input.command.slice(0, 60)
            : input.pattern || input.url || input.description || '');
          const tc: ToolCall = {
            toolUseId: block.id,
            name: block.name,
            category: categorize(block.name),
            inputPreview: sanitize(truncate(String(detail), 90)),
            filePath,
            resultPreview: null,
            isError: false,
          };
          tools.push(tc);
          if (block.id) result.toolsByUseId.set(block.id, tc);
        } else if (block.type === 'tool_result') {
          hasToolResult = true;
          const useId = block.tool_use_id;
          const owner = useId ? result.toolsByUseId.get(useId) : undefined;
          if (owner) {
            owner.isError = !!block.is_error;
            let resultText = '';
            if (typeof block.content === 'string') resultText = block.content;
            else if (Array.isArray(block.content)) {
              const t = block.content.find((c: any) => c && c.type === 'text');
              if (t) resultText = t.text ?? '';
            }
            owner.resultPreview = sanitize(truncate(resultText, 200));
          }
        }
      }
    }

    textFull = sanitize(textFull);

    if (role === 'assistant') {
      result.kind.set(uuid, 'A');
      result.preview.set(uuid, truncate(textFull || (tools.length ? `[${tools.map(t => t.name).join(', ')}]` : '')));
      result.text.set(uuid, textFull.slice(0, 3000));
      result.timestamp.set(uuid, d.timestamp ?? null);
      result.outputTokens.set(uuid, msg.usage?.output_tokens ?? 0);
      result.hasImage.set(uuid, hasImage);
      if (tools.length) result.toolsByOwner.set(uuid, tools);
      result.stats.keptNodes++;
    } else if (role === 'user') {
      if (d.isMeta) continue; // hook/system hand-offs, not a real turn
      if (interrupted) result.interrupted.set(uuid, true);
      if (hasToolResult && !hasText) {
        // synthetic tool-result carrier — not a real Q, leave out of `kind`
        // but it stays in allParent so descendants can be re-parented through it
      } else if (hasText && !isFakePrompt(textFull)) {
        // hasToolResult can still be true here (e.g. a fork's kickoff message
        // carries the "Fork started" ack alongside its real directive text) —
        // it's still a genuine prompt, so it's still Q.
        result.kind.set(uuid, 'Q');
        result.preview.set(uuid, truncate(textFull));
        result.text.set(uuid, textFull.slice(0, 3000));
        result.timestamp.set(uuid, d.timestamp ?? null);
        result.hasImage.set(uuid, hasImage);
        result.stats.keptNodes++;
      }
      // fake-prefixed text-only records fall through unclassified, same
      // re-parenting treatment as a T_RESULT
    }
  }

  return result;
}
