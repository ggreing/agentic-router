// T7 (decisions 104-111): what a request actually changed, for the request-end record.
// At the request's start the daemon notes, for every file that already differs from HEAD, its content
// fingerprint and its added / removed lines against HEAD. At the end the same is read against that start
// commit; a file counts only if its content changed during the request (a shared work tree: the user's
// earlier uncommitted work is not counted). Lines of a file that was clean at the start are exact; for a
// file that was already modified they are the difference of its two diffs (an approximation).
// git runs with the same hardening as the scope check (filters emptied, no external diff or textconv).
import fs from 'node:fs';
import path from 'node:path';
import { fileFingerprint, filterOverrides, git, headRef, repoRoot } from './git.ts';
import { normalizeEol, sameContent } from './tree.ts';

export const MAX_SNAPSHOT_FILES = 5000;
const MAX_COUNT_BYTES = 8 * 1024 * 1024;

export interface FileStat { fp: string; added: number; removed: number; binary?: boolean }

export interface RequestSnapshot {
  root: string;
  head?: string;
  files: Record<string, FileStat>;
  truncated?: boolean;
}

export interface ChangeStats {
  changedFiles: number;
  changedDirs: number;
  linesAdded: number;
  linesRemoved: number;
  newFiles: number;
  deletedFiles: number;
  binaryFiles: number;
  /** Lines of files already modified at the start are an approximation (difference of diffs). */
  approximate: boolean;
  truncated?: boolean;
}

const split0 = (s: string) => s.split('\0').filter(Boolean);

/** Added / removed lines of every file that differs from `base` (tracked: git numstat; untracked: line count). */
async function diffStats(root: string, base: string | undefined): Promise<{ stats: Record<string, Omit<FileStat, 'fp'>>; status: Record<string, string>; truncated: boolean }> {
  const extra = await filterOverrides(root);
  const stats: Record<string, Omit<FileStat, 'fp'>> = {};
  const status: Record<string, string> = {};
  if (base) {
    // -z numstat: "<added>\t<removed>\t<path>\0" ("-" for binary files); renames off
    for (const e of split0(await git(root, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', base, '--'], extra))) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(e);
      if (!m) continue;
      const binary = m[1] === '-';
      stats[m[3]!.replace(/\\/g, '/')] = { added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), ...(binary ? { binary } : {}) };
    }
    const ns = split0(await git(root, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', base, '--'], extra));
    for (let i = 0; i + 1 < ns.length; i += 2) status[ns[i + 1]!.replace(/\\/g, '/')] = ns[i]!.charAt(0);
  }
  for (const f of split0(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], extra)).map(x => x.replace(/\\/g, '/'))) {
    stats[f] = countLines(path.join(root, f));
    status[f] = 'A';
  }
  const names = Object.keys(stats);
  if (names.length <= MAX_SNAPSHOT_FILES) return { stats, status, truncated: false };
  return { stats: Object.fromEntries(names.sort().slice(0, MAX_SNAPSHOT_FILES).map(k => [k, stats[k]!])), status, truncated: true };
}

/** A new file's lines (all added); binary or very large files count as 0 lines. */
function countLines(file: string): Omit<FileStat, 'fp'> {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_COUNT_BYTES) return { added: 0, removed: 0, binary: true };
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) return { added: 0, removed: 0, binary: true };
    const text = normalizeEol(buf);
    let n = 0;
    for (const b of text) if (b === 10) n++;
    if (text.length && text[text.length - 1] !== 10) n++;
    return { added: n, removed: 0 };
  } catch {
    return { added: 0, removed: 0 };
  }
}

/** The work tree at the start of a request; undefined outside git. */
export async function takeRequestSnapshot(cwd: string): Promise<RequestSnapshot | undefined> {
  const root = await repoRoot(cwd);
  if (!root) return undefined;
  const head = await headRef(root);
  const { stats, truncated } = await diffStats(root, head);
  const files: Record<string, FileStat> = {};
  for (const [f, s] of Object.entries(stats)) files[f] = { fp: fileFingerprint(root, f), ...s };
  return { root, ...(head ? { head } : {}), files, ...(truncated ? { truncated } : {}) };
}

/** What changed in the work tree during the request (see the header). */
export async function requestChanges(snap: RequestSnapshot): Promise<ChangeStats> {
  const { stats: end, status, truncated } = await diffStats(snap.root, snap.head);
  const out: ChangeStats = { changedFiles: 0, changedDirs: 0, linesAdded: 0, linesRemoved: 0, newFiles: 0, deletedFiles: 0, binaryFiles: 0, approximate: false };
  const dirs = new Set<string>();
  for (const f of new Set([...Object.keys(snap.files), ...Object.keys(end)])) {
    const s = snap.files[f];
    const e = end[f] ?? { added: 0, removed: 0 };
    const now = fileFingerprint(snap.root, f);
    if (s ? sameContent(s.fp, now) : !(f in end)) continue;        // unchanged during the request
    out.changedFiles++;
    dirs.add(path.posix.dirname(f));
    if (e.binary || s?.binary) out.binaryFiles++;
    const a0 = s?.added ?? 0;
    const r0 = s?.removed ?? 0;
    out.linesAdded += Math.max(0, e.added - a0) + Math.max(0, r0 - e.removed);
    out.linesRemoved += Math.max(0, e.removed - r0) + Math.max(0, a0 - e.added);
    if (s) out.approximate = true;
    if (now === '-') out.deletedFiles++;
    else if ((s && s.fp === '-') || (!s && status[f] === 'A')) out.newFiles++;
  }
  out.changedDirs = dirs.size;
  if (truncated || snap.truncated) out.truncated = true;
  return out;
}
