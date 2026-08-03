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
  stats: ParseStats;
}

function truncate(s: string, n = 60): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n) + '…' : clean;
}

function isFakePrompt(text: string): boolean {
  const t = text.trim();
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
    stats: { totalLines: 0, parseErrors: 0, keptNodes: 0 },
  };

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
