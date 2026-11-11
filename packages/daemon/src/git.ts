// Read-only git queries for the scope check. Paths are repo-relative with forward slashes.
// The repository may have been edited by a subagent, so (audit #5):
// - git runs with a scrubbed environment, fsmonitor off, hooks pointed at an empty directory, no external
//   diff or textconv, and every configured filter driver (any config level) emptied, so no clean / smudge /
//   process command can run inside the daemon's own git;
// - the stop check compares git metadata and attributes with the filesystem before git runs at all.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTECTED_WRITE_PATHS } from '@agentic-router/core';
import { gitEnv } from './env.ts';
import { fingerprint, normalizeEol, sameContent, scanTree, type TreeMarks } from './tree.ts';

export { fingerprint } from './tree.ts';

const GIT_TIMEOUT_MS = 15_000;

let emptyHooks: string | undefined;
function emptyHooksDir(): string {
  if (!emptyHooks) {
    emptyHooks = path.join(os.tmpdir(), 'agentic-router-no-hooks');
    try { fs.mkdirSync(emptyHooks, { recursive: true }); } catch { /* best effort */ }
  }
  return emptyHooks;
}

const safeArgs = () => [
  '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-c', 'diff.external=', '-c', 'core.untrackedCache=false',
  '-c', `core.hooksPath=${emptyHooksDir()}`,
];

export function git(cwd: string, args: string[], extra: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...safeArgs(), ...extra, ...args], {
      cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8',
      env: gitEnv(),
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const split0 = (s: string) => s.split('\0').filter(Boolean);

/**
 * `-c` overrides that empty every filter driver configured anywhere (system, global, repository), so
 * that a `.gitattributes` `filter=` cannot make the daemon's git run a command. Reading the config is safe.
 */
export async function filterOverrides(cwd: string): Promise<string[]> {
  let out = '';
  try { out = await git(cwd, ['config', '--name-only', '-z', '--get-regexp', '^filter\\.']); } catch { return []; }   // exit 1: none
  const names = new Set<string>();
  for (const key of split0(out)) {
    const m = /^filter\.(.+)\.[^.]+$/i.exec(key.trim());
    if (m) names.add(m[1]!);
  }
  return [...names].flatMap(n => ['-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`]);
}

/** Top-level directory of the work tree containing `cwd`, or undefined outside git. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    return path.resolve((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    return undefined;
  }
}

export async function headRef(root: string): Promise<string | undefined> {
  try {
    return (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || undefined;
  } catch {
    return undefined;   // no commit yet
  }
}

/** Files that differ from `base` (committed, staged or unstaged) plus untracked, non-ignored files. */
export async function changedFiles(root: string, base: string | undefined): Promise<string[]> {
  const extra = await filterOverrides(root);
  const tracked = base
    ? await git(root, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', base, '--'], extra)
    : await git(root, ['ls-files', '--cached', '-z'], extra);
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], extra);
  return [...new Set([...split0(tracked), ...split0(untracked)])].map(f => f.replace(/\\/g, '/'));
}

export async function showFile(root: string, ref: string, rel: string): Promise<string | undefined> {
  try {
    return await git(root, ['show', '--no-textconv', `${ref}:${rel}`], await filterOverrides(root));
  } catch {
    return undefined;
  }
}

/** Content fingerprint of a work-tree file; '-' when it does not exist. */
export function fileFingerprint(root: string, rel: string): string {
  return fingerprint(path.join(root, rel));
}

// ------------------------------------------------------------------ files git is told not to look at (audit #8)

/** Tracked files marked assume-unchanged or skip-worktree: git diff does not report their changes. */
export async function flaggedFiles(root: string): Promise<string[]> {
  let out = '';
  try { out = await git(root, ['ls-files', '-v', '-z'], await filterOverrides(root)); } catch { return []; }
  const files: string[] = [];
  for (const e of split0(out)) {
    const tag = e[0] ?? '';
    if (tag === 'S' || (tag >= 'a' && tag <= 'z')) files.push(e.slice(2).replace(/\\/g, '/'));
  }
  return files;
}

/** Of `files`, those whose work-tree content differs from the index (compared without filters). */
export async function differsFromIndex(root: string, files: string[]): Promise<string[]> {
  if (!files.length) return [];
  const extra = await filterOverrides(root);
  const staged = new Map<string, string>();
  try {
    for (const e of split0(await git(root, ['ls-files', '-s', '-z', '--', ...files], extra))) {
      const m = /^\d+ ([0-9a-f]+) \d+\t(.*)$/s.exec(e);
      if (m) staged.set(m[2]!.replace(/\\/g, '/'), m[1]!);
    }
  } catch { return files; }
  const out: string[] = [];
  for (const f of files) {
    const sha = staged.get(f);
    let raw: Buffer;
    try { raw = fs.readFileSync(path.join(root, f)); } catch { out.push(f); continue; }
    if (!sha) { out.push(f); continue; }
    // decision 101: the index may hold the LF form of a CRLF work-tree file (autocrlf); that is no change
    const algo = sha.length === 64 ? 'sha256' : 'sha1';
    if (blobHash(algo, raw) !== sha && blobHash(algo, normalizeEol(raw)) !== sha) out.push(f);
  }
  return out;
}

/** Git's object id of a blob with this content. */
function blobHash(algo: 'sha1' | 'sha256', content: Buffer): string {
  return createHash(algo).update(`blob ${content.length}\0`).update(content).digest('hex');
}

/**
 * Decision 101: files whose work-tree text equals their text at `ref` once CRLF is read as LF (a line
 * ending rewrite of a file that was clean when the subtask started). Read through `git show --no-textconv`
 * with every filter emptied.
 */
export async function eolOnlyVsRef(root: string, ref: string | undefined, files: string[]): Promise<string[]> {
  if (!ref) return [];
  const out: string[] = [];
  for (const f of files.slice(0, 200)) {
    let now: Buffer;
    try { now = fs.readFileSync(path.join(root, f)); } catch { continue; }
    const before = await showFile(root, ref, f);
    if (before === undefined) continue;
    const a = normalizeEol(Buffer.from(before, 'utf8'));
    const b = normalizeEol(Buffer.from(now.toString('utf8'), 'utf8'));
    if (a.equals(b) && !Buffer.from(before, 'utf8').equals(Buffer.from(now.toString('utf8'), 'utf8'))) out.push(f);
  }
  return out;
}

// ------------------------------------------------------------------ git metadata (review #3, audit #5 #8)
//
// Files under .git are invisible to `git diff` / `ls-files`, but a subagent with Bash can plant a hook,
// set core.fsmonitor / core.hooksPath / a filter driver, or hide files through info/exclude. The stop
// check compares these with the start state, reading the files directly.

/** Label (as shown in reports) -> fingerprint. */
export type GitMeta = Record<string, string>;

export interface GitDirs { gitDir: string; common: string }

/** The work tree's own git dir and the shared one; they differ only in a linked worktree. */
export async function gitDirs(cwd: string): Promise<GitDirs | undefined> {
  try {
    const common = path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).trim());
    const gitDir = path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-dir'])).trim());
    return { gitDir, common };
  } catch {
    return undefined;
  }
}

/** config, config.worktree, info/exclude, info/attributes and every file in hooks/, read from disk. */
export function gitMetaOf({ gitDir, common }: GitDirs): GitMeta {
  const meta: GitMeta = {
    '.git/config': fingerprint(path.join(common, 'config')),
    '.git/info/exclude': fingerprint(path.join(common, 'info', 'exclude')),
    '.git/info/attributes': fingerprint(path.join(common, 'info', 'attributes')),
  };
  const own = path.relative(common, gitDir).replace(/\\/g, '/');   // '' in the main work tree, 'worktrees/<name>' in a worktree
  meta[own ? `.git/${own}/config.worktree` : '.git/config.worktree'] = fingerprint(path.join(gitDir, 'config.worktree'));
  let hooks: string[] = [];
  try { hooks = fs.readdirSync(path.join(common, 'hooks')); } catch { /* no hooks dir */ }
  for (const h of hooks) meta[`.git/hooks/${h}`] = fingerprint(path.join(common, 'hooks', h));
  return meta;
}

export async function gitMetaFingerprint(cwd: string): Promise<GitMeta | undefined> {
  const dirs = await gitDirs(cwd);
  return dirs ? gitMetaOf(dirs) : undefined;
}

/** Labels whose fingerprint differs (added, changed or removed), sorted. */
export function gitMetaChanges(before: GitMeta, after: GitMeta): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(k => !sameContent(before[k], after[k])).sort();   // line endings aside (decision 101)
}

// ------------------------------------------------------------------ snapshot

/** Work-tree state at SubagentStart: lets the stop check ignore changes that were already there. */
export interface Snapshot {
  root: string;
  head?: string;
  dirty: Record<string, string>;   // repo-relative path -> fingerprint at start
  truncated?: boolean;
  gitMeta?: GitMeta;               // .git config, info/ and hooks at start
  gitDirs?: GitDirs;               // where gitMeta lives, so the stop check reads it without git
  /** false: the user's own checkout, shared with the user and other sessions (decision 83: a lone writer). */
  isolated?: boolean;
  tree?: TreeMarks;                // .gitattributes, protected files (incl. ignored), verify inputs
  flagged?: Record<string, string>;   // assume-unchanged / skip-worktree files -> fingerprint
  /** Files the router's own verify commands wrote on an earlier stop (audit #9): not the subagent's. */
  artifacts?: Record<string, string>;
}

export const MAX_SNAPSHOT_FILES = 2000;

export async function takeSnapshot(cwd: string): Promise<Snapshot | undefined> {
  const root = await repoRoot(cwd);
  if (!root) return undefined;
  const head = await headRef(root);
  const files = await changedFiles(root, head);
  const dirty: Record<string, string> = {};
  for (const f of files.slice(0, MAX_SNAPSHOT_FILES)) dirty[f] = fileFingerprint(root, f);
  const dirs = await gitDirs(root);
  const flagged: Record<string, string> = {};
  for (const f of await flaggedFiles(root)) flagged[f] = fileFingerprint(root, f);
  return {
    root, ...(head ? { head } : {}), dirty, ...(files.length > MAX_SNAPSHOT_FILES ? { truncated: true } : {}),
    ...(dirs ? { gitMeta: gitMetaOf(dirs), gitDirs: dirs, isolated: dirs.gitDir !== dirs.common } : {}),
    tree: scanTree(root, PROTECTED_WRITE_PATHS),
    ...(Object.keys(flagged).length ? { flagged } : {}),
  };
}
