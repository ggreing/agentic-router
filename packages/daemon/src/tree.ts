// Filesystem-only view of a work tree (no git, no external programs), used where git itself cannot be
// trusted or does not see the change (audit #5, #8; decision 91):
//   attributes   every .gitattributes file: a changed one may switch on a filter driver, so the stop check
//                fails before git runs at all
//   protected    files matching the protected paths, including git-ignored ones such as .env
//   verifyInputs what the verify commands read: package.json scripts, test-runner / build / lint config
// One walk records all three; values are content fingerprints ('-' = absent).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { matchGlob } from './glob.ts';

const MAX_HASH_BYTES = 8 * 1024 * 1024;

/**
 * Content fingerprint of a file; '-' when it does not exist.
 * Decision 101 (env audit #11): a text file is hashed with CRLF read as LF, so a change of line endings
 * alone is not a change of content. When the file has CRLF the raw hash follows after '+', so such a
 * change is still visible (see sameContent / eolOnly).
 */
export function fingerprint(file: string): string {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return 'dir';
    if (st.size > MAX_HASH_BYTES) return `size:${st.size}:mtime:${st.mtimeMs}`;
    const raw = fs.readFileSync(file);
    const norm = normalizeEol(raw);
    const h = (b: Buffer) => createHash('sha1').update(b).digest('hex');
    return norm === raw ? h(raw) : `${h(norm)}+${h(raw)}`;
  } catch {
    return '-';
  }
}

/** CRLF -> LF for a text file (no NUL byte in its first 8000 bytes, git's rule); the same buffer otherwise. */
export function normalizeEol(buf: Buffer): Buffer {
  if (!buf.includes(13) || buf.subarray(0, 8000).includes(0)) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (!(buf[i] === 13 && buf[i + 1] === 10)) out[n++] = buf[i]!;
  return n === buf.length ? buf : out.subarray(0, n);
}

/** Same content, line endings aside. */
export function sameContent(a: string | undefined, b: string | undefined): boolean {
  const x = a ?? '-';
  const y = b ?? '-';
  return x === y || x.split('+')[0] === y.split('+')[0];
}

/** Changed only in line endings. */
export function eolOnly(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '-') !== (b ?? '-') && sameContent(a, b);
}

export interface TreeMarks {
  attributes: Record<string, string>;
  protected: Record<string, string>;
  verifyInputs: Record<string, string>;
  truncated?: boolean;
}

/** Directories never entered: git internals, dependencies, Claude Code worktrees, virtualenvs. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache']);
const SKIP_PATHS = ['.claude/worktrees'];
export const MAX_SCAN_ENTRIES = 50_000;

/**
 * Files the verify commands read (decision 91). A change since the subtask started holds the verify
 * commands for the user's confirmation instead of running them.
 */
export const VERIFY_INPUT_GLOBS = [
  '**/package.json',
  '**/jest.config.*', '**/vitest.config.*', '**/vitest.workspace.*', '**/playwright.config.*',
  '**/tsconfig*.json',
  '**/.eslintrc', '**/.eslintrc.*', '**/eslint.config.*',
  '**/Makefile', '**/makefile', '**/GNUmakefile',
  '**/pyproject.toml', '**/setup.cfg', '**/tox.ini', '**/pytest.ini', '**/conftest.py',
];

const isVerifyInput = (rel: string) => VERIFY_INPUT_GLOBS.some(g => matchGlob(rel, g));

/**
 * What of a verify input matters: package.json -> its scripts; pyproject.toml / setup.cfg -> the tool
 * sections ([tool.*] / [tool:*]) only, so a dependency bump does not hold verification; others -> the file.
 */
export function verifyInputFingerprint(file: string): string {
  const base = path.basename(file);
  if (base !== 'package.json' && base !== 'pyproject.toml' && base !== 'setup.cfg') return fingerprint(file);
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return '-'; }
  const hash = (s: string) => createHash('sha1').update(s).digest('hex');
  if (base === 'package.json') {
    try {
      const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts ?? null;
      return `scripts:${hash(JSON.stringify(scripts))}`;
    } catch {
      return `unparsable:${hash(text)}`;     // a broken package.json is a change worth holding for
    }
  }
  const sections: string[] = [];
  let keep = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) keep = /^tool[.:]/.test(header[1]!.trim());
    if (keep) sections.push(line);
  }
  return `tool:${hash(sections.join('\n'))}`;
}

export function scanTree(root: string, protectedGlobs: readonly string[]): TreeMarks {
  const marks: TreeMarks = { attributes: {}, protected: {}, verifyInputs: {} };
  let seen = 0;
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > MAX_SCAN_ENTRIES) { marks.truncated = true; return; }
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || SKIP_PATHS.includes(r)) continue;
        // a nested repository or worktree is not part of this tree
        if (fs.existsSync(path.join(abs, '.git'))) continue;
        walk(abs, r);
        continue;
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      if (e.name === '.gitattributes') marks.attributes[r] = fingerprint(abs);
      if (protectedGlobs.some(g => matchGlob(r, g))) marks.protected[r] = fingerprint(abs);
      if (isVerifyInput(r)) marks.verifyInputs[r] = verifyInputFingerprint(abs);
    }
  };
  walk(root, '');
  return marks;
}

/** Keys whose content differs between two records (added, changed or removed; line endings aside), sorted. */
export function changedKeys(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(k => !sameContent(before[k], after[k])).sort();
}
