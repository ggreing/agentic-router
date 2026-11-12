// `agentic-router policy show|accept|revoke [--project <dir>] [--yes]` (decision 142): a repository's
// .agentic-router/policy.json (extra Bash commands for workers, extra verify variables) is ignored until the user
// accepts its exact content; a change to the file needs a new acceptance. The guard owns the rules and the
// record (plugin/hooks/guard.mjs); this is its front end, and doctor's line.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
}
export interface GuardPolicy {
  policyRoot(dir: string): string;
  policyStatus(root: string): PolicyStatus;
  acceptPolicy(root: string): PolicyStatus;
  revokePolicy(root: string): boolean;
}

/** guard.mjs of the plugin this router uses (config.pluginDir, else the repository's plugin folder). */
export async function loadGuard(pluginDir = readConfig()?.pluginDir): Promise<GuardPolicy> {
  const dir = pluginDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugin');
  return await import(pathToFileURL(path.join(dir, 'hooks', 'guard.mjs')).href) as GuardPolicy;
}

const list = (v: unknown[] | undefined) => (v && v.length ? v.map(x => JSON.stringify(x)).join(', ') : 'none');

export function describePolicy(root: string, s: PolicyStatus): string[] {
  if (!s.present) return [`${root}: no .agentic-router/policy.json`];
  const state = !s.valid ? `not valid${s.error ? ` (${s.error})` : ''}: ignored`
    : s.accepted ? 'accepted' : s.acceptedHash ? 'changed since you accepted it: ignored until you accept it again' : 'not accepted: ignored';
  return [
    `${path.join(root, '.agentic-router', 'policy.json')} (sha256 ${s.hash?.slice(0, 12) ?? '?'}): ${state}`,
    `  bashAllow (extra commands workers may run): ${list(s.policy?.bashAllow)}`,
    `  verifyEnv (extra variables passed to verify): ${list(s.policy?.verifyEnv)}`,
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
    const after = d.guard.acceptPolicy(root);
    d.out(after.accepted ? 'Accepted. A change to the file needs a new `agentic-router policy accept`.' : 'Not accepted: the file changed or is no longer valid.');
    return after.accepted ? 0 : 1;
  }
  if (sub === 'revoke') {
    d.out(d.guard.revokePolicy(root) ? `Revoked: ${root}'s policy is ignored again.` : `${root} has no accepted policy.`);
    return 0;
  }
  d.out('usage: agentic-router policy show|accept|revoke [--project <dir>] [--yes]');
  return 2;
}

/** doctor's line for the current project's policy. */
export function policyCheck(guard: GuardPolicy, dir: string): Check {
  const root = guard.policyRoot(dir);
  const s = guard.policyStatus(root);
  if (!s.present) return { name: 'project policy', ok: true, blocking: false, detail: 'none in this repository' };
  const [first] = describePolicy(root, s);
  return { name: 'project policy', ok: s.valid && s.accepted, blocking: false, detail: s.valid && !s.accepted ? `${first} (see it with \`agentic-router policy show\`, accept with \`agentic-router policy accept\`)` : first! };
}
