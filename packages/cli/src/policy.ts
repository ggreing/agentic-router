// `do-it-all-claude-code policy show|accept|revoke [--project <dir>] [--yes]` (decision 142): a repository's
// .do-it-all-claude-code/policy.json (extra Bash commands for workers, extra verify variables) is ignored until the user
// accepts its exact content; a change to the file needs a new acceptance. The guard owns the rules and the
// record (plugin/hooks/guard.mjs); this is its front end, and doctor's line.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEGACY_PROJECT_DIR, PROJECT_DIR } from '@do-it-all-claude-code/core';
import type { Check } from './doctor.ts';
import { readConfig } from './setup.ts';

export interface PolicyStatus {
  present: boolean;
  valid: boolean;
  hash: string | null;
  accepted: boolean;
  acceptedHash: string | null;
  policy: { bashAllow?: unknown[]; verifyEnv?: unknown[] } | null;
  error?: string;
  /** The file read (decision 161: the previous release's folder when only it has a policy), and whether it is that one. */
  file?: string;
  legacy?: boolean;
}
export interface GuardPolicy {
  policyRoot(dir: string): string;
  policyStatus(root: string): PolicyStatus;
  /** expectedHash (audit N5): nothing is recorded when the file is no longer the content that was shown. */
  acceptPolicy(root: string, stateHome?: string, now?: Date, expectedHash?: string): PolicyStatus & { changed?: boolean };
  revokePolicy(root: string): boolean;
}

/** guard.mjs of the plugin this router uses (config.pluginDir, else the repository's plugin folder). */
export async function loadGuard(pluginDir = readConfig()?.pluginDir): Promise<GuardPolicy> {
  const dir = pluginDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugin');
  return await import(pathToFileURL(path.join(dir, 'hooks', 'guard.mjs')).href) as GuardPolicy;
}

/**
 * Audit N5: an entry as the terminal shows it: quoted, with everything outside printable ASCII escaped, so a
 * control sequence, a bidi override or a zero-width character cannot hide or rewrite what is being accepted.
 */
export const shownEntry = (x: unknown): string =>
  `"${String(x).replace(/[^\x20-\x7e]|["\\]/g, c => (c === '"' || c === '\\' ? `\\${c}` : `\\u{${c.codePointAt(0)!.toString(16).padStart(4, '0')}}`))}"`;

/** Entries of the file the guard leaves out (more than 100, longer than 200, not a string); for the listing. */
function droppedEntries(file: string, key: 'bashAllow' | 'verifyEnv', kept: number): number {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Array.isArray(j[key]) ? Math.max(0, (j[key] as unknown[]).length - kept) : 0;
  } catch { return 0; }
}

export function describePolicy(root: string, s: PolicyStatus): string[] {
  if (!s.present) return [`${root}: no ${PROJECT_DIR}/policy.json`];
  const file = s.file ?? path.join(root, PROJECT_DIR, 'policy.json');
  const state = !s.valid ? `not valid${s.error ? ` (${s.error})` : ''}: ignored`
    : s.accepted ? 'accepted' : s.acceptedHash ? 'changed since you accepted it: ignored until you accept it again' : 'not accepted: ignored';
  const section = (key: 'bashAllow' | 'verifyEnv', label: string) => {
    const entries = s.policy?.[key] ?? [];
    const dropped = droppedEntries(file, key, entries.length);
    return [
      `  ${key} (${label}): ${entries.length ? `${entries.length}` : 'none'}${dropped ? ` (${dropped} more in the file are ignored: over 100 entries, over 200 characters, or not text)` : ''}`,
      ...entries.map(x => `    - ${shownEntry(x)}`),
    ];
  };
  return [
    `${file} (sha256 ${s.hash?.slice(0, 12) ?? '?'}): ${state}${s.legacy ? ` (in the previous release's folder: rename ${LEGACY_PROJECT_DIR} to ${PROJECT_DIR}; the acceptance stays)` : ''}`,
    ...section('bashAllow', 'extra commands workers may run'),
    ...section('verifyEnv', 'extra variables passed to verify'),
  ];
}

export interface PolicyDeps { guard: GuardPolicy; dir: string; ask(q: string): Promise<boolean>; isTTY: boolean; out(line: string): void }

export async function policyCommand(sub: string | undefined, f: Record<string, string | boolean>, d: PolicyDeps): Promise<number> {
  const root = d.guard.policyRoot(d.dir);
  const s = d.guard.policyStatus(root);
  if (sub === 'show') { for (const l of describePolicy(root, s)) d.out(l); return 0; }
  if (sub === 'accept') {
    for (const l of describePolicy(root, s)) d.out(l);
    if (!s.present) return 2;
    if (!s.valid) { d.out('Fix the file first: an invalid policy cannot be accepted.'); return 2; }
    if (s.accepted) { d.out('Already accepted.'); return 0; }
    d.out('Accepting lets subagents in this repository run the commands above and passes the variables above to verify.');
    if (f.yes !== true) {
      if (!d.isTTY) { d.out('Not a terminal: re-run with --yes to accept.'); return 1; }
      if (!await d.ask('Accept this policy? [y/N] ')) { d.out('Not accepted.'); return 1; }
    }
    // audit N5: record the content that was shown, or nothing (a build script or watcher may rewrite the file meanwhile)
    const after = d.guard.acceptPolicy(root, undefined, undefined, s.hash ?? undefined);
    d.out(after.accepted ? 'Accepted. A change to the file needs a new `do-it-all-claude-code policy accept`.'
      : after.changed ? 'Not accepted: the file changed while you were asked. Run `do-it-all-claude-code policy accept` again to see its current content.'
      : 'Not accepted: the file changed or is no longer valid.');
    return after.accepted ? 0 : 1;
  }
  if (sub === 'revoke') {
    d.out(d.guard.revokePolicy(root) ? `Revoked: ${root}'s policy is ignored again.` : `${root} has no accepted policy.`);
    return 0;
  }
  d.out('usage: do-it-all-claude-code policy show|accept|revoke [--project <dir>] [--yes]');
  return 2;
}

/**
 * Decision 161: a project that still has the previous release's folder. Its policy.json, verify.json and
 * teams.yaml are read from it for this release, each only when the new folder has no file of that name.
 */
export function projectFolderCheck(root: string): Check | null {
  if (!fs.existsSync(path.join(root, LEGACY_PROJECT_DIR))) return null;
  const both = fs.existsSync(path.join(root, PROJECT_DIR));
  return { name: 'project folder', ok: false, blocking: false, detail: both
    ? `${root} has both ${LEGACY_PROJECT_DIR} and ${PROJECT_DIR}: a file missing in ${PROJECT_DIR} is still read from ${LEGACY_PROJECT_DIR}; move what is left and remove ${LEGACY_PROJECT_DIR}`
    : `${root} has the previous release's ${LEGACY_PROJECT_DIR}: rename it to ${PROJECT_DIR} (it is still read for this release)` };
}

/** doctor's line for the current project's policy. */
export function policyCheck(guard: GuardPolicy, dir: string): Check {
  const root = guard.policyRoot(dir);
  const s = guard.policyStatus(root);
  if (!s.present) return { name: 'project policy', ok: true, blocking: false, detail: 'none in this repository' };
  const [first] = describePolicy(root, s);
  return { name: 'project policy', ok: s.valid && s.accepted, blocking: false, detail: s.valid && !s.accepted ? `${first} (see it with \`do-it-all-claude-code policy show\`, accept with \`do-it-all-claude-code policy accept\`)` : first! };
}
