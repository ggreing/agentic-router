// `agentic-router policy show|accept|revoke` and doctor's line (decision 142): a project policy is ignored until
// the user accepts its exact content, and again after it changes. The guard keeps the record (temp router home).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadGuard, policyCheck, policyCommand, type GuardPolicy } from '../src/policy.ts';

const PLUGIN = fileURLToPath(new URL('../../../plugin/', import.meta.url));
let tmp = '';
let repo = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-pol-'));
  process.env.AGENTIC_ROUTER_HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.AGENTIC_ROUTER_HOME, { recursive: true });
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, '.agentic-router'), { recursive: true });
});
const writePolicy = (o: unknown) => fs.writeFileSync(path.join(repo, '.agentic-router', 'policy.json'), JSON.stringify(o));

async function run(guard: GuardPolicy, sub: string, f: Record<string, string | boolean> = {}, o: { tty?: boolean; answer?: boolean } = {}) {
  const lines: string[] = [];
  const code = await policyCommand(sub, f, { guard, dir: repo, ask: async () => o.answer ?? true, isTTY: o.tty ?? true, out: l => { lines.push(l); } });
  return { code, text: lines.join('\n') };
}

test('decision 142: a policy is shown, accepted only after the user says yes, ignored again when it changes, and revocable', async () => {
  const guard = await loadGuard(PLUGIN);
  assert.match((await run(guard, 'show')).text, /no \.agentic-router\/policy\.json/);
  assert.deepEqual(policyCheck(guard, repo), { name: 'project policy', ok: true, blocking: false, detail: 'none in this repository' });
  writePolicy({ verifyEnv: ['MY_TOOLCHAIN'] });
  const shown = await run(guard, 'show');
  assert.match(shown.text, /not accepted: ignored\n {2}bashAllow .*: none\n {2}verifyEnv .*: "MY_TOOLCHAIN"/);
  const check = policyCheck(guard, repo);
  assert.deepEqual([check.ok, check.blocking], [false, false]);
  assert.match(check.detail, /agentic-router policy accept/);
  assert.equal((await run(guard, 'accept', {}, { answer: false })).code, 1);
  assert.equal((await run(guard, 'accept', {}, { tty: false })).code, 1, 'no terminal and no --yes');
  assert.equal(guard.policyStatus(guard.policyRoot(repo)).accepted, false);
  const ok = await run(guard, 'accept');
  assert.equal(ok.code, 0);
  assert.match(ok.text, /Accepted\./);
  assert.equal(policyCheck(guard, repo).ok, true);
  // the relay passes the accepted variable to verify, and only while the acceptance holds
  const relay = await import(pathToFileURL(path.join(PLUGIN, 'hooks', 'relay.mjs')).href) as { buildVerifyEnv(env: NodeJS.ProcessEnv, names?: string[]): Record<string, string> };
  const accepted = await import(pathToFileURL(path.join(PLUGIN, 'hooks', 'guard.mjs')).href) as { acceptedVerifyEnvNames(dir: string): string[] };
  assert.deepEqual(accepted.acceptedVerifyEnvNames(repo), ['MY_TOOLCHAIN']);
  assert.equal(relay.buildVerifyEnv({ MY_TOOLCHAIN: 'tc' }, accepted.acceptedVerifyEnvNames(repo)).MY_TOOLCHAIN, 'tc');
  writePolicy({ verifyEnv: ['MY_TOOLCHAIN', 'OTHER'] });
  assert.match((await run(guard, 'show')).text, /changed since you accepted it: ignored until you accept it again/);
  assert.deepEqual(accepted.acceptedVerifyEnvNames(repo), []);
  assert.equal((await run(guard, 'accept', { yes: true }, { tty: false })).code, 0, '--yes for scripts');
  assert.match((await run(guard, 'revoke')).text, /Revoked/);
  assert.equal(guard.policyStatus(guard.policyRoot(repo)).accepted, false);
  assert.match((await run(guard, 'revoke')).text, /has no accepted policy/);
  writePolicy('not an object');
  assert.equal((await run(guard, 'accept', { yes: true })).code, 2);
  assert.equal((await run(guard, 'nonsense')).code, 2);
});
