import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

function realpathOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}
// macOS resolves /var -> /private/var, so os.tmpdir()'s unresolved path never
// string-matches a cwd Claude Code already recorded post-resolution.
const TMPDIR_REAL = realpathOrSelf(os.tmpdir());

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProjectInfo {
  dirName: string;
  displayPath: string;
  sessionCount: number;
}

export interface ForkFileInfo {
  filePath: string;
  agentId: string;
  meta: { agentType?: string; isFork?: boolean; name?: string; description?: string } | null;
}

function readCwdFromSession(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const chunk = buf.toString('utf8', 0, bytesRead);
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (typeof d.cwd === 'string' && d.cwd) return d.cwd;
      } catch {
        // partial line at buffer boundary — skip
      }
    }
  } catch {
    // unreadable — fall through to null
  }
  return null;
}

export function listProjects(): ProjectInfo[] {
  if (!fs.existsSync(CLAUDE_PROJECTS_ROOT)) return [];
  const dirs = fs.readdirSync(CLAUDE_PROJECTS_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory());

  return dirs.map(e => {
    const full = path.join(CLAUDE_PROJECTS_ROOT, e.name);
    const sessionFiles = fs.readdirSync(full, { withFileTypes: true })
      .filter(f => f.isFile() && f.name.endsWith('.jsonl') && UUID_RE.test(f.name.replace('.jsonl', '')));

    let displayPath = e.name;
    for (const f of sessionFiles) {
      const cwd = readCwdFromSession(path.join(full, f.name));
      if (cwd) { displayPath = cwd; break; }
    }

    return {
      dirName: e.name,
      displayPath,
      sessionCount: sessionFiles.length,
    };
  }).filter(p => p.sessionCount > 0)
    // the compaction feature runs `claude -p` with cwd=os.tmpdir() so it never
    // pollutes the actual project it's summarizing — but that subprocess call
    // is itself logged as its own "project" here. Hide it, it's noise, not a session.
    .filter(p => realpathOrSelf(p.displayPath) !== TMPDIR_REAL)
    // lightest project first so the browser's initial auto-load stays snappy;
    // heavier merged/forked trees are one dropdown click away
    .sort((a, b) => a.sessionCount - b.sessionCount);
}

export function listSessionFiles(projectDirName: string): { sessionId: string; filePath: string }[] {
  const full = path.join(CLAUDE_PROJECTS_ROOT, projectDirName);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true })
    .filter(f => f.isFile() && f.name.endsWith('.jsonl'))
    .map(f => {
      const sessionId = f.name.replace(/\.jsonl$/, '');
      return { sessionId, filePath: path.join(full, f.name) };
    })
    .filter(f => UUID_RE.test(f.sessionId));
}

export function listForkFiles(projectDirName: string, sessionId: string): ForkFileInfo[] {
  const subagentsDir = path.join(CLAUDE_PROJECTS_ROOT, projectDirName, sessionId, 'subagents');
  if (!fs.existsSync(subagentsDir)) return [];
  const files = fs.readdirSync(subagentsDir, { withFileTypes: true })
    .filter(f => f.isFile() && f.name.startsWith('agent-') && f.name.endsWith('.jsonl'));

  return files.map(f => {
    const agentId = f.name.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const metaPath = path.join(subagentsDir, f.name.replace(/\.jsonl$/, '.meta.json'));
    let meta = null;
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { meta = null; }
    }
    return { filePath: path.join(subagentsDir, f.name), agentId, meta };
  });
}
