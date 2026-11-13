// Session-end verification (spec 3.5): run the verify commands in the subagent's work tree and
// check the edit scope (git diff against the start state + untracked files). Returns VerifySignal[].
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RELATED_TESTS_PLACEHOLDER, type SignalKind, type VerifySignal } from '@do-it-all-claude-code/core';
import { verifyEnv } from './env.ts';
import {
  changedFiles, differsFromIndex, eolOnlyVsRef, fileFingerprint, flaggedFiles, gitMetaChanges, gitMetaOf, headRef, repoRoot,
  type GitMeta, type Snapshot,
} from './git.ts';
import { matchesAny, matchesScope, scopeCaseInsensitive } from './glob.ts';
import { tailText } from './payload.ts';
import { verifyShell, zeroTestsRan, type Shell } from './shell.ts';
import { SKIP_DIRS, SKIP_PATHS, changedKeys, eolOnly, sameContent, scanTree, type TreeMarks } from './tree.ts';

export interface VerifyCommand {
  kind: SignalKind;
  command: string;
  timeoutMs?: number;
  /** Repo-relative path; when it does not exist the step is skipped and recorded as ok (decision 70). */
  ifExists?: string;
  /** Repo-relative path; while it exists the step is skipped and recorded as ok (decision 86), e.g. an install step. */
  ifMissing?: string;
  /** Decision 122: repo-relative paths; the step runs when any of them exists (e.g. the pytest config files). */
  ifAnyExists?: string[];
}

/** Decision Q2: 120 s per command, 240 s for the whole verification. */
export const COMMAND_TIMEOUT_MS = 120_000;
export const TOTAL_TIMEOUT_MS = 240_000;
const OUTPUT_KEEP = 64 * 1024;
const DETAIL_MAX = 1500;

/** Paths that Claude Code itself creates in the main work tree. */
export const SCOPE_IGNORE = ['.claude/worktrees/**'];

export interface ScopeSpec {
  allowed: string[];
  protected: string[];
  /**
   * Decision 129: protected paths this subtask may edit (granted by router_request_scope after a user
   * turn). A change to one is neither a protected-path change nor out of scope. Matched by the file
   * system's case rule, like the scope; git metadata and attributes are never covered.
   */
  protectedGranted?: string[];
  unscoped: boolean;
  /** Work-tree state when the subagent started; changes already present then are not attributed to it. */
  snapshot?: Snapshot | null;
  /** Shared work tree: globs other subtasks of the request may edit (their changes are not this agent's). */
  sharedAllowed?: string[];
  /**
   * Shared work tree (audit #9): repo-relative paths this subagent's Edit / Write / NotebookEdit calls
   * touched, from its transcript. Out-of-scope changes it did not touch may be another process's and are
   * only reported. Undefined (no transcript): every out-of-scope change counts.
   */
  editedPaths?: string[];
}

/** What the verification found beyond the signals, for the router's verdict. */
export interface VerifyOutcome {
  /** Decision 91: verify inputs that changed since the subtask started; the commands were held, not run. */
  held?: string[];
  /** Git metadata or attributes changed: git and the verify commands were not run. */
  gitBlocked?: boolean;
  /** Files (and git metadata) the verify commands themselves changed; the next stop ignores them. */
  artifacts?: Record<string, string>;
  /** Decision 98: no bash to run the commands in; they were held, not run. */
  noShell?: string;
  /** Decision 122: commands that failed because a tool is missing here (not the subagent's failure). */
  envMissing?: string[];
}

export interface VerifyPlan {
  cwd: string;
  /** Top of the work tree under verification; `ifExists` / `ifMissing` paths resolve against it (default: cwd). */
  root?: string;
  commands: VerifyCommand[];
  scope?: ScopeSpec;
  commandTimeoutMs?: number;
  totalTimeoutMs?: number;
  secrets?: string[];
  signal?: AbortSignal;
  /** Decision 99: environment of the commands (default: the daemon's, scrubbed). */
  env?: NodeJS.ProcessEnv;
  /** Decision 98: shell to run them in (default: verifyShell()). */
  shell?: Shell;
  /** Filled in by runVerify. */
  outcome?: VerifyOutcome;
}

export async function runVerify(plan: VerifyPlan): Promise<VerifySignal[]> {
  // The scope check runs first, so files the verify commands produce (build output, caches) are
  // never attributed to the subagent. It is still reported last.
  const outcome: VerifyOutcome = {};
  plan.outcome = outcome;
  const sc = plan.scope && !plan.signal?.aborted ? await scopeCheck(plan.cwd, plan.scope) : undefined;
  const out: VerifySignal[] = [];
  const total = plan.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const deadline = Date.now() + total;
  if (sc?.gitBlocked) {
    // The verify commands may run git (hooks, package scripts); with its config changed they are not run.
    outcome.gitBlocked = true;
    for (const c of plan.commands) out.push({ kind: c.kind, ok: false, detail: `${c.command}: not run, git metadata or attributes changed (see scope)` });
    out.push(sc.signal);
    return out;
  }
  const snap = plan.scope?.snapshot;
  if (snap?.tree && sc?.scan && plan.commands.length) {
    const held = changedKeys(snap.tree.verifyInputs, sc.scan.verifyInputs);
    if (held.length) {
      outcome.held = held;
      for (const c of plan.commands) {
        out.push({ kind: c.kind, ok: false, detail: `${c.command}: held, ${list(held)} changed since the subtask started; ask the user to confirm before running` });
      }
      if (sc) out.push(sc.signal);
      return out;
    }
  }
  for (const c of plan.commands) {
    if (plan.signal?.aborted) break;
    if (c.ifExists !== undefined) {
      const present = existsInTree(plan.root ?? plan.cwd, c.ifExists);
      if (present === 'invalid') { out.push({ kind: c.kind, ok: false, detail: `${c.command}: invalid ifExists path "${c.ifExists}"` }); continue; }
      if (!present) { out.push({ kind: c.kind, ok: true, detail: `${c.command}: skipped (no ${c.ifExists})` }); continue; }
    }
    if (c.ifAnyExists !== undefined) {
      const found = c.ifAnyExists.map(p => existsInTree(plan.root ?? plan.cwd, p));
      if (found.includes('invalid')) { out.push({ kind: c.kind, ok: false, detail: `${c.command}: invalid ifAnyExists path in [${c.ifAnyExists.join(', ')}]` }); continue; }
      if (!found.includes(true)) { out.push({ kind: c.kind, ok: true, detail: `${c.command}: skipped (none of ${c.ifAnyExists.join(', ')})` }); continue; }
    }
    if (c.ifMissing !== undefined) {
      const present = existsInTree(plan.root ?? plan.cwd, c.ifMissing);
      if (present === 'invalid') { out.push({ kind: c.kind, ok: false, detail: `${c.command}: invalid ifMissing path "${c.ifMissing}"` }); continue; }
      if (present) { out.push({ kind: c.kind, ok: true, detail: `${c.command}: skipped (${c.ifMissing} present)` }); continue; }
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      out.push({ kind: c.kind, ok: false, detail: `${c.command}: not run, total verify time limit (${Math.round(total / 1000)}s) reached` });
      continue;
    }
    const env = plan.env ?? verifyEnv();
    const shell = plan.shell ??= await verifyShell(env);
    if (!shell.ok) {
      outcome.noShell = shell.reason;
      out.push({ kind: c.kind, ok: false, detail: `${c.command}: held, ${shell.reason}` });
      continue;
    }
    // decision 122: {relatedTests} becomes the test files related to this subtask's changes
    let command = c.command;
    if (command.includes(RELATED_TESTS_PLACEHOLDER)) {
      const tests = relatedTests(plan.root ?? plan.cwd, sc?.changed ?? []);
      if (!tests.length) { out.push({ kind: c.kind, ok: true, detail: `${c.command}: no related tests (not run; neither a pass nor a miss)` }); continue; }
      command = command.split(RELATED_TESTS_PLACEHOLDER).join(tests.map(shQuote).join(' '));
    }
    const limit = Math.min(c.timeoutMs ?? plan.commandTimeoutMs ?? COMMAND_TIMEOUT_MS, left);
    const t0 = Date.now();
    const r = await runCommand(command, plan.cwd, limit, plan.signal, { env, shell });
    // decision 149: the structured result, stored whatever recordPrompts says (the output tail is not)
    const facts = { exitCode: r.code, durationMs: Date.now() - t0, ...testCounts(r.output) };
    const zero = !r.timedOut && !r.aborted ? zeroTestsRan(command, r.output, r.code) : undefined;
    const ok = !r.timedOut && !r.aborted && r.code === 0 && !zero;
    const status = r.aborted ? 'aborted' : r.timedOut ? `timed out after ${Math.round(limit / 1000)}s`
      : zero ? `0 tests ran (${zero}; exit ${r.code ?? r.signal})` : `exit ${r.code ?? r.signal}`;
    const missing = !ok && !zero && !r.timedOut && !r.aborted ? missingTool(r.code, r.output) : undefined;
    if (missing) {
      outcome.envMissing = [...(outcome.envMissing ?? []), c.command];
      out.push({ kind: c.kind, ok: false, detail: `${command}: ${ENV_MARK}${missing} (exit ${r.code ?? r.signal}); verify cannot run this here, not counted as the subagent's failure`, ...facts });
      continue;
    }
    const tail = ok ? '' : tailText(r.output, DETAIL_MAX, plan.secrets);
    out.push({ kind: c.kind, ok, detail: `${command}: ${status}${tail ? `\n${tail}` : ''}`, ...facts });
  }
  // What the commands themselves wrote (build info, caches) is recorded so the next stop does not count it.
  if (sc?.state && snap && plan.commands.length && !plan.signal?.aborted) {
    try {
      const artifacts: Record<string, string> = {};
      for (const f of await changedFiles(snap.root, snap.head)) {
        const now = fileFingerprint(snap.root, f);
        if (sc.state[f] !== now) artifacts[f] = now;
      }
      for (const [f, before] of Object.entries(sc.state)) {
        const now = fileFingerprint(snap.root, f);
        if (before !== now && !(f in artifacts)) artifacts[f] = now;   // deleted by the commands
      }
      if (snap.gitDirs && sc.meta) {
        const meta = gitMetaOf(snap.gitDirs);
        for (const k of gitMetaChanges(sc.meta, meta)) artifacts[`#meta:${k}`] = meta[k] ?? '-';
      }
      if (Object.keys(artifacts).length) outcome.artifacts = artifacts;
    } catch { /* best effort: without artifacts the next stop is only stricter */ }
  }
  if (sc) out.push(sc.signal);
  return out;
}

const TEST_FILE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|[^/]*\.(test|spec)\.[cm]?[jt]sx?)$/;
const MAX_RELATED = 50;

/**
 * Decision 122: the test files related to a subtask's changes: test files it changed or added, and for a
 * changed module the tests named after it (test_<m>.py / <m>_test.py, <m>.test.* / <m>.spec.*) anywhere in
 * the tree (dependencies, virtualenvs and git internals skipped). Sorted, at most MAX_RELATED.
 */
export function relatedTests(root: string, changed: readonly string[]): string[] {
  const out = new Set<string>();
  const names = new Set<string>();
  for (const f of changed) {
    if (!fs.existsSync(path.join(root, f))) continue;
    if (TEST_FILE.test(f)) { out.add(f); continue; }
    const base = path.posix.basename(f);
    const py = /^(.+)\.py$/.exec(base);
    if (py && py[1] !== '__init__' && py[1] !== 'conftest') { names.add(`test_${py[1]}.py`); names.add(`${py[1]}_test.py`); continue; }
    const js = /^(.+)\.([cm]?[jt]sx?)$/.exec(base);
    if (js) for (const k of ['test', 'spec']) names.add(`${js[1]}.${k}.${js[2]}`);
  }
  if (names.size) {
    let seen = 0;
    const walk = (dir: string, rel: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (++seen > 50_000) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !SKIP_PATHS.includes(r)) walk(path.join(dir, e.name), r); continue; }
        if (e.isFile() && names.has(e.name)) out.add(r);
      }
    };
    walk(root, '');
  }
  return [...out].sort().slice(0, MAX_RELATED);
}

/** A path as one bash word. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Marks a signal whose command could not run in this environment (decision 122). */
export const ENV_MARK = 'environment: ';

export const isEnvFailure = (s: VerifySignal) => !s.ok && s.kind !== 'scope' && (s.detail ?? '').includes(`: ${ENV_MARK}`);

/**
 * Decision 122: a failure because a program is not installed here (bash "command not found" / exit 127,
 * cmd.exe "is not recognized as an internal or external command", e.g. npm scripts on Windows) says
 * nothing about the subagent's work. Returns what was missing, or undefined.
 */
/**
 * Decision 149: the pass and fail counts a test runner printed, from its last summary (node --test "ℹ pass N",
 * TAP "# pass N", pytest "N passed, N failed", jest/vitest "Tests: N failed, N passed", mocha "N passing").
 * Only numbers leave the output; nothing when there is no summary.
 */
export function testCounts(output: string): { testsPassed?: number; testsFailed?: number } {
  const last = (res: RegExp[]) => {
    let found: number | undefined;
    for (const re of res) for (const m of output.matchAll(re)) found = Number(m[1]);
    return found;
  };
  const passed = last([/(?:ℹ|#) pass (\d+)/g, /\b(\d+) (?:passed|passing)\b/g]);
  const failed = last([/(?:ℹ|#) fail (\d+)/g, /\b(\d+) (?:failed|failing)\b/g]);
  return { ...(passed !== undefined ? { testsPassed: passed } : {}), ...(failed !== undefined ? { testsFailed: failed } : {}) };
}

export function missingTool(code: number | null, output: string): string | undefined {
  const cmd = /'([^'\r\n]+)' is not recognized as an internal or external command/.exec(output);
  if (cmd) return `${cmd[1]} not found`;
  const sh = /(?:^|\n)(?:[^\n:]*: )?(?:line \d+: |\d+: )?([^\s:'"]+): (?:command )?not found\b/.exec(output);
  if (sh && /command not found|: not found/.test(output)) return `${sh[1]} not found`;
  if (/command not found|is not recognized as an internal or external command/.test(output)) return 'a command was not found';
  if (/No module named '?pytest'?(\s|$)/.test(output)) return 'pytest not installed';   // the test runner itself is missing
  if (code === 127) return 'a command was not found (exit 127)';
  return undefined;
}

/** Repo-relative path syntax accepted for `ifExists` / `ifMissing` (same rule as core's role file schema). */
export function validTreePath(p: string): boolean {
  return !!p && !/^([/\\]|[A-Za-z]:)|(^|[/\\])\.\.([/\\]|$)/.test(p);
}

/**
 * Whether `rel` exists inside the work tree. A path that resolves (through symlinks or junctions)
 * outside the tree counts as absent; a malformed path is 'invalid' (the step fails closed).
 */
export function existsInTree(root: string, rel: string): boolean | 'invalid' {
  if (!validTreePath(rel)) return 'invalid';
  try {
    // the native call on both sides: it also expands Windows 8.3 names, which the JS one keeps
    const realRoot = fs.realpathSync.native(root);
    const real = fs.realpathSync.native(path.resolve(root, rel));
    const inside = path.relative(realRoot, real);
    return inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside));
  } catch {
    return false;   // missing, or a dangling link
  }
}

// ------------------------------------------------------------------ commands

export interface CommandResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
}

export async function runCommand(
  command: string, cwd: string, timeoutMs: number, abort?: AbortSignal, run: { env?: NodeJS.ProcessEnv; shell?: Shell } = {},
): Promise<CommandResult> {
  const env = run.env ?? verifyEnv();
  const shell = run.shell ?? await verifyShell(env);
  if (!shell.ok) return { code: null, signal: null, timedOut: false, aborted: false, output: shell.reason };
  return new Promise(resolve => {
    let output = '';
    let timedOut = false;
    let aborted = false;
    const keep = (b: Buffer) => {
      output += b.toString('utf8');
      if (output.length > OUTPUT_KEEP) output = output.slice(output.length - OUTPUT_KEEP);
    };
    let child;
    try {
      child = spawn(shell.file, ['-c', command], {
        cwd, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      resolve({ code: null, signal: null, timedOut: false, aborted: false, output: String(e) });
      return;
    }
    const kill = () => killTree(child.pid);
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { aborted = true; kill(); };
    abort?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', e => keep(Buffer.from(String(e))));
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      abort?.removeEventListener('abort', onAbort);
      resolve({ code, signal: sig, timedOut, aborted, output });
    });
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

// ------------------------------------------------------------------ scope

export { matchGlob } from './glob.ts';

interface ScopeResult {
  signal: VerifySignal;
  gitBlocked?: boolean;
  scan?: TreeMarks;
  /** Fingerprints of the changed files at check time (before the verify commands). */
  state?: Record<string, string>;
  meta?: GitMeta;
  /** Files changed during the subtask (decision 122: what {relatedTests} looks at). */
  changed?: string[];
}

export async function checkScope(cwd: string, spec: ScopeSpec): Promise<VerifySignal> {
  return (await scopeCheck(cwd, spec)).signal;
}

/**
 * Order (audit #5): git metadata and .gitattributes are compared through the filesystem first; if
 * either changed, git is not run at all (a filter or hook could execute). Then git, with every filter
 * driver emptied, lists the changes; assume-unchanged / skip-worktree files and protected files that git
 * ignores are compared directly (audit #8).
 */
async function scopeCheck(cwd: string, spec: ScopeSpec): Promise<ScopeResult> {
  const snap = spec.snapshot ?? undefined;
  const root = snap?.root ?? await repoRoot(cwd);
  if (!root) return { signal: { kind: 'scope', ok: true, detail: 'skipped: not a git work tree' } };
  const shared = snap?.isolated === false || (spec.sharedAllowed?.length ?? 0) > 0;
  const sharedNote = ' (git directory is shared with the main work tree and other worktrees: may come from another session)';
  // decision 129: a protected path granted to this subtask counts as inside its scope
  const granted = (f: string) => matchesScope(f, spec.protectedGranted ?? []);
  const isProtected = (f: string) => matchesAny(f, spec.protected) && !granted(f);
  const artifacts = snap?.artifacts ?? {};

  // 1. git metadata, read from disk
  let meta: GitMeta | undefined;
  if (snap?.gitMeta && snap.gitDirs) {
    meta = gitMetaOf(snap.gitDirs);
    const changed = gitMetaChanges(snap.gitMeta, meta).filter(k => artifacts[`#meta:${k}`] !== meta![k]);
    if (changed.length) {
      return { gitBlocked: true, signal: { kind: 'scope', ok: false, detail: `protected paths changed (need user confirmation): ${list(changed)}${sharedNote}; git and the verify commands were not run` } };
    }
  }
  // 2. attributes and protected files, read from disk
  const scan = snap?.tree ? scanTree(root, spec.protected) : undefined;
  if (snap?.tree && scan) {
    const attrs = changedKeys(snap.tree.attributes, scan.attributes);
    if (attrs.length) {
      return { gitBlocked: true, scan, signal: { kind: 'scope', ok: false, detail: `git attributes changed (a filter or diff driver could run; need user confirmation): ${list(attrs)}; git and the verify commands were not run` } };
    }
  }
  // 3. git, filters emptied
  let files: string[];
  try {
    files = await changedFiles(root, snap ? snap.head : await headRef(root));
  } catch (e) {
    return { signal: { kind: 'scope', ok: false, detail: `could not list changed files: ${String(e).slice(0, 300)}` } };
  }
  if (!snap) {
    // No start snapshot (the subagent's start state was never recorded): with no baseline, this subagent's
    // changes cannot be told from the user's uncommitted work, so nothing fails; what differs is reported.
    const candidates = files.filter(f => !matchesAny(f, SCOPE_IGNORE));
    // No start snapshot (the subagent's start state was never recorded): with no baseline, this subagent's
    // changes cannot be told from the user's uncommitted work, so nothing fails; what differs is reported.
    const outsideAll = candidates.filter(f => !granted(f) && !matchesScope(f, spec.allowed) && !matchesScope(f, spec.sharedAllowed ?? []));
    const prot = candidates.filter(isProtected);
    const parts = [`no start snapshot (baseline unknown): ${candidates.length} uncommitted change(s) against HEAD`];
    if (outsideAll.length) parts.push(`outside the allowed scope [${spec.allowed.join(', ')}]: ${list(outsideAll)}`);
    if (prot.length) parts.push(`protected paths: ${list(prot)}`);
    const caveat = outsideAll.length || prot.length ? ' (may include the user\'s own uncommitted changes; not counted as a failure)' : '';
    return { changed: candidates, signal: { kind: 'scope', ok: true, detail: `${parts.join('; ')}${caveat}` } };
  }

  // Files git does not report: assume-unchanged / skip-worktree, and protected files it ignores (.env).
  const hidden: string[] = [];
  const flaggedNow = await flaggedFiles(root);
  const known = snap.flagged ?? {};
  for (const f of flaggedNow) if (f in known && !sameContent(known[f], fileFingerprint(root, f))) hidden.push(f);
  hidden.push(...await differsFromIndex(root, flaggedNow.filter(f => !(f in known))));
  if (snap.tree && scan) hidden.push(...changedKeys(snap.tree.protected, scan.protected));

  // Only what changed during this subtask counts. A file already modified or untracked at SubagentStart
  // is the user's own work while its content is unchanged; a change to it, including reverting or
  // deleting it (audit #7), is this subagent's. Files the router's verify wrote on an earlier stop are not.
  const before = snap.dirty;
  const candidates = [...new Set([...files, ...hidden, ...Object.keys(before)])].filter(f => !matchesAny(f, SCOPE_IGNORE)).sort();
  const state: Record<string, string> = {};
  for (const f of candidates) state[f] = fileFingerprint(root, f);
  // Decision 101: a file whose content is the same apart from line endings is not counted (a formatter, an
  // editor or git's autocrlf rewrote it); it is named in the report.
  const untouched = candidates.filter(f => f in before && sameContent(before[f], state[f]));
  const eol = untouched.filter(f => eolOnly(before[f], state[f]));
  let mine = candidates.filter(f => !untouched.includes(f) && !(f in artifacts && sameContent(artifacts[f], state[f])));
  const outOfScope = (f: string) => isProtected(f) || (!granted(f) && !matchesScope(f, spec.allowed) && !matchesScope(f, spec.sharedAllowed ?? []));
  const eolVsHead = await eolOnlyVsRef(root, snap.head, mine.filter(f => !(f in before) && state[f] !== '-' && outOfScope(f)));
  if (eolVsHead.length) {
    eol.push(...eolVsHead);
    mine = mine.filter(f => !eolVsHead.includes(f));
  }
  const protectedHits = mine.filter(isProtected);
  const outside = mine.filter(f => !protectedHits.includes(f) && !granted(f) && !matchesScope(f, spec.allowed) && !matchesScope(f, spec.sharedAllowed ?? []));

  // Shared work tree (audit #9): an out-of-scope change counts only if this subagent's edit tools touched
  // it. Decision 95: the user's own uncommitted work that is now reverted (same as HEAD again) or deleted
  // always counts, since that work may be lost; a further edit to it follows the normal rule.
  const fold = (p: string) => (scopeCaseInsensitive() ? p.toLowerCase() : p);
  const edited = spec.editedPaths ? new Set(spec.editedPaths.map(fold)) : undefined;
  const lostWork = outside.filter(f => f in before && (state[f] === '-' || !files.includes(f)));
  const confirmed = shared && edited ? outside.filter(f => edited.has(fold(f)) || lostWork.includes(f)) : outside;
  const unconfirmed = outside.filter(f => !confirmed.includes(f));

  const where = shared
    ? `shared work tree (the user's checkout${untouched.length ? `; ${untouched.length} uncommitted change(s) that were already there are not counted` : ''}): `
    : '';
  const problems: string[] = [];
  if (protectedHits.length) problems.push(`protected paths changed (need user confirmation): ${list(protectedHits)}${shared ? ' (shared work tree: may come from another session)' : ''}`);
  const otherOutside = confirmed.filter(f => !lostWork.includes(f));
  if (otherOutside.length) problems.push(`changed outside the allowed scope [${spec.allowed.join(', ')}]: ${list(otherOutside)}`);
  if (lostWork.length) problems.push(`the user's uncommitted work was reverted or deleted outside the allowed scope (may be the user; restore it or report it): ${list(lostWork)}`);
  const notes: string[] = [];
  if (unconfirmed.length) notes.push(`changed outside the scope but not by this subagent's edit tools (may be another process; not counted): ${list(unconfirmed)}`);
  if (eol.length) notes.push(`line endings only (not counted): ${list(eol.sort())}`);
  if (scan?.truncated || snap.truncated) notes.push('start snapshot truncated');
  const tail = notes.length ? `; ${notes.join('; ')}` : '';
  if (problems.length) return { scan, state, changed: mine, ...(meta ? { meta } : {}), signal: { kind: 'scope', ok: false, detail: `${where}${problems.join('; ')}${tail}` } };
  const note = spec.unscoped ? 'unscoped (no [scope: ...] line, whole repository allowed); ' : '';
  const counted = mine.length - unconfirmed.length;
  return { scan, state, changed: mine, ...(meta ? { meta } : {}), signal: { kind: 'scope', ok: true, detail: `${where}${note}${counted} file(s) changed during the subtask${tail}` } };
}

function list(files: string[], max = 20): string {
  return files.length > max ? `${files.slice(0, max).join(', ')} and ${files.length - max} more` : files.join(', ');
}
