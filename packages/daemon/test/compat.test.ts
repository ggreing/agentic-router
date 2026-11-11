// Compatibility decisions 97-101 and items #9 / #13 of the compatibility review, plus audit E16.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROTECTED_WRITE_PATHS } from '@agentic-router/core';
import { cleanVerifyEnv, gitEnv, isSecretName, scrubbedEnv, verifyEnv, withoutEnvValues } from '../src/env.ts';
import { takeSnapshot } from '../src/git.ts';
import { homeLayout, tightenPermissions, writeJsonAtomic } from '../src/home.ts';
import { BASH_NOT_FOUND, findShell, zeroTestsRan } from '../src/shell.ts';
import { fingerprint, sameContent, eolOnly } from '../src/tree.ts';
import { checkScope, runVerify } from '../src/verify.ts';
import {
  claudeAdapter, getStatus, git, makeHome, makeRepo, postHook, rmrf, rows, startTestDaemon, tmpDir, write, type HookInput, type TestDaemon,
} from './helpers.ts';

const PROTECTED = [...PROTECTED_WRITE_PATHS];
const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
type Out = { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };

const session = (d: TestDaemon, sid: string, cwd: string) => async (h: HookInput): Promise<Out> => {
  const r = await postHook(d.port, { session_id: sid, cwd, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
  assert.equal(r.status, 200, r.text);
  return r.body as Out;
};
let seq = 0;
const call = (tag: string, scope: string): HookInput => ({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_x${++seq}`,
  tool_input: { subagent_type: 'agentic-router:coder', prompt: `[subtask:${tag}] work\n[scope: ${scope}]`, model: 'haiku', effort: 'low' },
});
const start = (agentId: string, extra: HookInput = {}): HookInput => ({ hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'agentic-router:coder', ...extra });
const stop = (agentId: string, extra: HookInput = {}): HookInput => ({ hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: 'agentic-router:coder', stop_hook_active: false, ...extra });

// ------------------------------------------------------------------ decision 99: environments

test('decision 99: secret names are narrow; ordinary settings stay', () => {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'MY_SERVICE_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'GOOGLE_APPLICATION_CREDENTIALS', 'PGPASSWORD', 'DB_PASSWD', 'BASIC_AUTH', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'NPM_CONFIG__AUTH', 'SESSION_COOKIE', 'AGENTIC_ROUTER_HOME']) {
    assert.equal(isSecretName(k), true, k);
  }
  for (const k of ['AWS_REGION', 'AWS_PROFILE', 'DOCKER_HOST', 'SESSION_STORE', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'CLAUDE_PROJECT_DIR', 'GH_HOST', 'PATH', 'JAVA_HOME']) {
    assert.equal(isSecretName(k), false, k);
  }
  const base = { PATH: '/usr/bin', AWS_REGION: 'eu-west-1', MY_TOKEN: 't', NODE_OPTIONS: '--require /tmp/x.js', GIT_DIR: '/elsewhere/.git', GIT_CONFIG_COUNT: '1', GIT_AUTHOR_NAME: 'u' };
  assert.deepEqual(scrubbedEnv(base), { PATH: '/usr/bin', AWS_REGION: 'eu-west-1', NODE_OPTIONS: '--require /tmp/x.js', GIT_DIR: '/elsewhere/.git', GIT_CONFIG_COUNT: '1', GIT_AUTHOR_NAME: 'u' });
  // the daemon's own git: no GIT_*, no NODE_OPTIONS, prompts and optional locks off
  assert.deepEqual(gitEnv(base), { PATH: '/usr/bin', AWS_REGION: 'eu-west-1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  // a verify: the forwarded toolchain wins (case-insensitively on Windows), NODE_OPTIONS never passes
  const v = verifyEnv({ Path: 'C:\\venv\\Scripts;C:\\Windows', VIRTUAL_ENV: 'C:\\venv', NODE_OPTIONS: '--inspect', API_KEY: 'k' }, base, 'win32');
  assert.deepEqual(v, { AWS_REGION: 'eu-west-1', GIT_DIR: '/elsewhere/.git', GIT_CONFIG_COUNT: '1', GIT_AUTHOR_NAME: 'u', Path: 'C:\\venv\\Scripts;C:\\Windows', VIRTUAL_ENV: 'C:\\venv' });
  assert.equal(verifyEnv({ Path: '/venv/bin' }, base, 'linux').PATH, '/usr/bin');   // POSIX names are case-sensitive
  // what the daemon accepts from a relay
  assert.equal(cleanVerifyEnv('PATH=/x'), undefined);
  assert.equal(cleanVerifyEnv({ NODE_OPTIONS: 'x', MY_SECRET: 'y', 'BAD NAME': 'z', N: 3 }), undefined);
  assert.deepEqual(cleanVerifyEnv({ A: 'x'.repeat(32 * 1024 + 1), B: 'ok' }), { B: 'ok' });
  assert.equal(Object.keys(cleanVerifyEnv(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`V${i}`, 'x'])))!).length, 256);
  assert.deepEqual(withoutEnvValues({ hook_event_name: 'SubagentStart', verifyEnv: { PATH: '/secret/looking/path' } }), { hook_event_name: 'SubagentStart', verifyEnv: ['PATH'] });
});

test('decision 99: a subagent\'s verify runs with the variables its relay forwarded; the ledger keeps only their names', async () => {
  const repo = makeRepo({ 'src/a.ts': 'a\n', 'env.cjs': 'const e = process.env; process.exit(e.AR_TOOLCHAIN === "tc-1" && !e.NODE_OPTIONS && !e.MY_API_KEY ? 0 : 3)\n' });
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [{ kind: 'test', command: 'node env.cjs' }] } });
  try {
    const post = session(d, 'env', repo);
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the bug where parse() fails on empty input in src/a.ts' });
    await post(call('A', 'src/**'));
    await post(start('e1', { verifyEnv: { AR_TOOLCHAIN: 'tc-1', NODE_OPTIONS: '--require ./evil.cjs', MY_API_KEY: 'k-123' } }));
    write(repo, 'src/a.ts', 'b\n');
    assert.deepEqual(await post(stop('e1')), {});
    assert.deepEqual(rows(d, "SELECT status, verdict FROM subtasks WHERE id = 'A'"), [{ status: 'passed', verdict: 'meet' }]);
    assert.deepEqual(JSON.parse(String(rows(d, "SELECT verify_env FROM agents WHERE agent_id = 'e1'")[0]!.verify_env)), { AR_TOOLCHAIN: 'tc-1' });
    const payload = String(rows(d, "SELECT payload FROM events WHERE type = 'subagent_start'")[0]!.payload);
    assert.deepEqual(JSON.parse(payload).verifyEnv, ['AR_TOOLCHAIN', 'NODE_OPTIONS', 'MY_API_KEY']);
    assert.ok(!payload.includes('tc-1') && !payload.includes('k-123'), payload);
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
});

// ------------------------------------------------------------------ decision 98: bash, zero tests

test('decision 98: the verify shell is bash: Git Bash on Windows (never WSL), /bin/bash or /bin/sh elsewhere', async () => {
  const files = (...ok: string[]) => (p: string) => ok.includes(p);
  assert.deepEqual(await findShell({ platform: 'linux', isFile: files('/bin/bash') }), { ok: true, file: '/bin/bash', name: 'bash' });
  assert.deepEqual(await findShell({ platform: 'linux', isFile: files() }), { ok: true, file: '/bin/sh', name: 'sh' });
  const gitExec = async () => 'C:/Program Files/Git/mingw64/libexec/git-core';
  const env = { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps;D:\\tools\\msys\\usr\\bin' };
  // 1. CLAUDE_CODE_GIT_BASH_PATH
  assert.deepEqual(await findShell({ platform: 'win32', env: { ...env, CLAUDE_CODE_GIT_BASH_PATH: 'E:\\Git\\bin\\bash.exe' }, isFile: files('E:\\Git\\bin\\bash.exe'), gitExecPath: gitExec }),
    { ok: true, file: 'E:\\Git\\bin\\bash.exe', name: 'bash' });
  // 2. the Git for Windows install of the git on PATH
  assert.deepEqual(await findShell({ platform: 'win32', env, isFile: files('C:\\Program Files\\Git\\bin\\bash.exe'), gitExecPath: gitExec }),
    { ok: true, file: 'C:\\Program Files\\Git\\bin\\bash.exe', name: 'bash' });
  // 3. PATH, skipping the WSL launchers
  const wsl = files('C:\\Windows\\System32\\bash.exe', 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe', 'D:\\tools\\msys\\usr\\bin\\bash.exe');
  assert.deepEqual(await findShell({ platform: 'win32', env, isFile: wsl, gitExecPath: async () => undefined }), { ok: true, file: 'D:\\tools\\msys\\usr\\bin\\bash.exe', name: 'bash' });
  assert.deepEqual(await findShell({ platform: 'win32', env, isFile: files('C:\\Windows\\System32\\bash.exe'), gitExecPath: async () => undefined }), { ok: false, reason: BASH_NOT_FOUND });
  // and this machine has one: bash syntax works in a verify command on every OS
  const dir = makeRepo({ 'ok.cjs': 'process.exit(process.env.X === "1" ? 0 : 4)\n' });
  try {
    const s = await runVerify({ cwd: dir, commands: [{ kind: 'test', command: 'X=1 node ok.cjs && [ -n "$BASH_VERSION$0" ]' }] });
    assert.equal(s[0]!.ok, true, s[0]!.detail);
  } finally { rmrf(dir); }
});

test('decision 98: no bash: the commands are held, not run, and the lead is told', async () => {
  const noShell = { ok: false as const, reason: BASH_NOT_FOUND };
  const dir = makeRepo({ 'mark.cjs': 'require("fs").writeFileSync("ran.txt", "x")\n' });
  try {
    const plan = { cwd: dir, root: dir, shell: noShell, commands: [{ kind: 'build' as const, command: 'npm ci', ifExists: 'package-lock.json' }, { kind: 'test' as const, command: 'node mark.cjs' }] };
    const s = await runVerify(plan);
    assert.deepEqual(s.map(x => [x.ok, x.detail]), [[true, 'npm ci: skipped (no package-lock.json)'], [false, `node mark.cjs: held, ${BASH_NOT_FOUND}`]]);
    assert.equal(fs.existsSync(path.join(dir, 'ran.txt')), false);
    assert.equal((plan as { outcome?: { noShell?: string } }).outcome?.noShell, BASH_NOT_FOUND);
  } finally { rmrf(dir); }

  const repo = makeRepo({ 'src/a.ts': 'a\n' });
  const d = await startTestDaemon({ verify: { shell: noShell, resolveCommands: async () => [{ kind: 'test', command: 'npm test' }] } });
  try {
    const post = session(d, 'nobash', repo);
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the typo in the error message in src/a.ts' });
    await post(call('A', 'src/**'));
    await post(start('n1'));
    write(repo, 'src/a.ts', 'b\n');
    assert.deepEqual(await post(stop('n1')), {});
    assert.deepEqual(rows(d, "SELECT status, verdict FROM subtasks WHERE id = 'A'"), [{ status: 'hitl', verdict: 'held' }]);
    const n = await post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>n1</task-id>\n<status>completed</status>\n</task-notification>' });
    assert.match(n.hookSpecificOutput?.additionalContext ?? '', /subtask A .*: verify held: bash not found \(install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH\); the verify commands did not run.*Tell the user\./);
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
});

test('decision 98: a test run that ran no tests is a miss, also with exit code 0', async () => {
  assert.equal(zeroTestsRan('npm test', 'ℹ tests 0\nℹ suites 0\nℹ pass 0\n', 0), 'node --test: tests 0');
  assert.equal(zeroTestsRan('node --test', 'TAP version 13\n1..0\n# tests 0\n# pass 0\n', 0), 'node --test: tests 0');
  assert.equal(zeroTestsRan('npm test -ws', 'ℹ tests 0\n...\nℹ tests 12\n', 0), undefined);   // one workspace has tests
  assert.equal(zeroTestsRan('npm test', '\x1b[34mℹ tests 242\x1b[39m\n', 0), undefined);
  assert.equal(zeroTestsRan('pytest -q', '\n============ no tests ran in 0.01s ============\n', 5), 'pytest: no tests ran');
  assert.equal(zeroTestsRan('python -m pytest', '', 5), 'pytest: no tests ran');
  assert.equal(zeroTestsRan('make check', '', 5), undefined);
  assert.equal(zeroTestsRan('npx jest', 'No tests found, exiting with code 0\n', 0), 'jest: No tests found');
  assert.equal(zeroTestsRan('npx vitest run', 'No test files found, exiting with code 1\n', 1), 'vitest: No test files found');
  assert.equal(zeroTestsRan('npx mocha', '\n  0 passing (1ms)\n', 0), 'mocha: 0 passing');
  assert.equal(zeroTestsRan('npx mocha', '\n  3 passing (4ms)\n', 0), undefined);
  assert.equal(zeroTestsRan('npm test', '5 passed, 0 failed\n', 0), undefined);
  const dir = makeRepo({ 'none.cjs': 'console.log("ℹ tests 0"); console.log("ℹ pass 0")\n' });
  try {
    const s = await runVerify({ cwd: dir, commands: [{ kind: 'test', command: 'node none.cjs' }] });
    assert.equal(s[0]!.ok, false);
    assert.match(s[0]!.detail!, /^node none\.cjs: 0 tests ran \(node --test: tests 0; exit 0\)/);
  } finally { rmrf(dir); }
});

// ------------------------------------------------------------------ decision 101: line endings

test('decision 101: fingerprints read CRLF as LF; a change of line endings only is visible but not a change', () => {
  const dir = tmpDir('eol');
  try {
    const f = path.join(dir, 'a.txt');
    fs.writeFileSync(f, 'one\ntwo\n');
    const lf = fingerprint(f);
    fs.writeFileSync(f, 'one\r\ntwo\r\n');
    const crlf = fingerprint(f);
    assert.notEqual(lf, crlf);
    assert.equal(sameContent(lf, crlf), true);
    assert.equal(eolOnly(lf, crlf), true);
    fs.writeFileSync(f, 'one\r\nTWO\r\n');
    assert.equal(sameContent(crlf, fingerprint(f)), false);
    fs.writeFileSync(f, Buffer.from([0, 13, 10, 65]));          // binary: bytes as they are
    const bin = fingerprint(f);
    fs.writeFileSync(f, Buffer.from([0, 10, 65]));
    assert.equal(sameContent(bin, fingerprint(f)), false);
    assert.equal(sameContent('-', undefined), true);
  } finally { rmrf(dir); }
});

test('decision 101 (env audit #11): a line ending rewrite outside the scope is not counted and is named', async () => {
  for (const autocrlf of ['false', 'true', 'input']) {
    const dir = makeRepo({ 'src/a.ts': 'a\n', 'docs/clean.md': 'one\ntwo\n', 'docs/dirty.md': 'x\ny\n' });
    try {
      git(dir, 'config', 'core.autocrlf', autocrlf);
      write(dir, 'docs/dirty.md', 'x\ny\nthe user\'s own line\n');      // the user's uncommitted work
      const snapshot = await takeSnapshot(dir);
      write(dir, 'src/a.ts', 'a2\n');                                     // the subagent's in-scope edit
      const flip = (rel: string) => {
        const p = path.join(dir, rel);
        const t = fs.readFileSync(p, 'utf8');
        fs.writeFileSync(p, t.includes('\r\n') ? t.replace(/\r\n/g, '\n') : t.replace(/\n/g, '\r\n'));
      };
      flip('docs/clean.md');                                              // a formatter flips line endings
      flip('docs/dirty.md');
      const s = await checkScope(dir, { allowed: ['src/**'], protected: PROTECTED, unscoped: false, snapshot });
      assert.equal(s.ok, true, `autocrlf=${autocrlf}: ${s.detail}`);
      assert.match(s.detail!, /line endings only \(not counted\): .*docs\/dirty\.md/, `autocrlf=${autocrlf}: ${s.detail}`);
      // a real change next to it still counts
      write(dir, 'docs/clean.md', 'changed\n');
      const s2 = await checkScope(dir, { allowed: ['src/**'], protected: PROTECTED, unscoped: false, snapshot });
      assert.equal(s2.ok, false, `autocrlf=${autocrlf}: ${s2.detail}`);
      assert.match(s2.detail!, /changed outside the allowed scope \[src\/\*\*\]: docs\/clean\.md/);
    } finally { rmrf(dir); }
  }
});

test('decision 101: a clean out-of-scope file rewritten to CRLF (autocrlf=false) is not counted', async () => {
  const dir = makeRepo({ 'src/a.ts': 'a\n', 'docs/n.md': 'one\ntwo\n' });
  try {
    git(dir, 'config', 'core.autocrlf', 'false');
    const snapshot = await takeSnapshot(dir);
    write(dir, 'src/a.ts', 'a2\n');
    fs.writeFileSync(path.join(dir, 'docs/n.md'), 'one\r\ntwo\r\n');
    const s = await checkScope(dir, { allowed: ['src/**'], protected: PROTECTED, unscoped: false, snapshot });
    assert.equal(s.ok, true, s.detail);
    assert.match(s.detail!, /1 file\(s\) changed during the subtask; line endings only \(not counted\): docs\/n\.md/);
  } finally { rmrf(dir); }
});

// ------------------------------------------------------------------ decision 100: old spool events

test('decision 100: spooled events older than 24 hours are dropped, not replayed', async () => {
  const home = makeHome();
  try {
    const now = new Date('2026-11-11T12:00:00.000Z');
    const spool = path.join(home, 'spool');
    fs.mkdirSync(spool, { recursive: true });
    const line = (sid: string, at: string) => JSON.stringify({ receivedAt: at, input: { session_id: sid, hook_event_name: 'SessionStart', cwd: home, source: 'startup' } });
    fs.writeFileSync(path.join(spool, '1.jsonl'), [line('old', '2026-11-10T11:59:00.000Z'), line('recent', '2026-11-11T11:00:00.000Z')].join('\n') + '\n');
    const d = await startTestDaemon({ home, now: () => now });
    try {
      assert.deepEqual(d.replay, { files: 1, events: 1, errors: 0, dropped: 1 });
      assert.deepEqual(rows(d, 'SELECT session_id FROM events').map(r => r.session_id), ['recent']);
      const log = fs.readdirSync(path.join(home, 'logs')).map(f => fs.readFileSync(path.join(home, 'logs', f), 'utf8')).join('');
      assert.match(log, /spooled events older than 24 h dropped, not replayed.*"dropped":1/);
    } finally { await d.close(); }
  } finally { rmrf(home); }
});

// ------------------------------------------------------------------ compatibility #9 / #13

test('#9: a rename blocked by a short-lived lock is retried; a lasting failure removes the tmp file and throws', () => {
  const dir = tmpDir('atomic');
  try {
    const file = path.join(dir, 'a.json');
    const tmps = () => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
    let calls = 0;
    writeJsonAtomic(file, { v: 1 }, (from, to) => {
      if (++calls < 3) throw Object.assign(new Error('locked'), { code: calls === 1 ? 'EBUSY' : 'EPERM' });
      fs.renameSync(from, to);
    });
    assert.equal(calls, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 });
    calls = 0;
    const t0 = Date.now();
    assert.throws(() => writeJsonAtomic(file, { v: 2 }, () => { calls++; throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), /denied/);
    assert.equal(calls, 7);
    assert.ok(Date.now() - t0 >= 900, 'about a second of retries');
    assert.deepEqual(tmps(), []);
    calls = 0;
    assert.throws(() => writeJsonAtomic(file, { v: 3 }, () => { calls++; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }), /gone/);
    assert.equal(calls, 1);                                                // not a lock: no retry
    assert.deepEqual(tmps(), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 });
  } finally { rmrf(dir); }
});

test('#9: an Agent call whose scope file cannot be written is denied and leaves no subtask', async () => {
  const d = await startTestDaemon();
  try {
    const post = session(d, 'nofile', d.home);
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the typo in the error message in src/a.ts' });
    fs.mkdirSync(homeLayout(d.home).scopeFile('nofile', 'A'), { recursive: true });   // a folder where the file goes
    const out = await post(call('A', 'src/**'));
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? '', /subtask A: the router could not write its scope file/);
    assert.deepEqual(rows(d, 'SELECT id FROM subtasks'), []);
  } finally { await d.close(); rmrf(d.home); }
});

test('#13: on POSIX the router home is made private at start (folders 0700, files 0600)', { skip: process.platform === 'win32' }, async () => {
  const home = makeHome();
  try {
    const h = homeLayout(home);
    for (const dir of [h.root, h.spoolDir, h.logsDir]) { fs.mkdirSync(dir, { recursive: true }); fs.chmodSync(dir, 0o755); }
    fs.writeFileSync(path.join(h.spoolDir, 'x.jsonl'), '');
    fs.chmodSync(path.join(h.spoolDir, 'x.jsonl'), 0o644);
    fs.chmodSync(h.token, 0o644);
    tightenPermissions(h);
    const mode = (p: string) => fs.statSync(p).mode & 0o777;
    assert.equal(mode(h.root), 0o700);
    assert.equal(mode(h.spoolDir), 0o700);
    assert.equal(mode(h.logsDir), 0o700);
    assert.equal(mode(path.join(h.spoolDir, 'x.jsonl')), 0o600);
    assert.equal(mode(h.token), 0o600);
    fs.rmSync(path.join(h.spoolDir, 'x.jsonl'));
    const d = await startTestDaemon({ home });
    try { assert.equal(mode(h.db), 0o600); } finally { await d.close(); }
  } finally { rmrf(home); }
});

// ------------------------------------------------------------------ decision 97: router clients

test('decision 97: the status lists what the hooks of the latest sessions see (node, home, port)', async () => {
  let t = Date.parse('2026-11-11T10:00:00.000Z');
  const d = await startTestDaemon({ now: () => new Date(t) });
  try {
    const client = { node: 'C:\\nodejs\\node.exe', nodeVersion: 'v24.22.1', routerHome: 'C:\\Users\\u\\.agentic-router', port: 47821 };
    for (let i = 0; i < 12; i++) {
      t += 1000;
      await postHook(d.port, { session_id: `s${i}`, hook_event_name: 'SessionStart', source: 'startup', cwd: d.home, routerClient: { ...client, port: 47000 + i } });
    }
    await postHook(d.port, { session_id: 'bad', hook_event_name: 'SessionStart', source: 'startup', cwd: d.home, routerClient: { node: 7, port: 'x' } });
    await d.router.process(claudeAdapter.toRouterEvent(
      { session_id: 's11', hook_event_name: 'SessionStart', source: 'startup', cwd: d.home, routerClient: { ...client, port: 1 } },
      { spooled: true, receivedAt: '2026-11-11T09:00:00.000Z' }));   // an older replayed start does not replace the newer
    const status = (await getStatus(d.port)).body as { clients: Array<Record<string, unknown>> };
    assert.equal(status.clients.length, 10);
    assert.deepEqual(status.clients[0], { sessionId: 'bad', node: null, nodeVersion: null, routerHome: null, port: null, seenAt: '2026-11-11T10:00:12.000Z' });
    assert.deepEqual(status.clients[1], { sessionId: 's11', ...client, port: 47011, seenAt: '2026-11-11T10:00:12.000Z' });
    assert.equal(status.clients[9]!.sessionId, 's3');
    const one = (await getStatus(d.port, 's4')).body as { clients: unknown[] };
    assert.equal(one.clients.length, 10);
  } finally { await d.close(); rmrf(d.home); }
});

// ------------------------------------------------------------------ audit E16

test('E16: foreground subagents that start out of order are paired by the tag in their own transcript', async () => {
  const repo = makeRepo({ 'src/a/x.ts': 'a\n', 'src/b/x.ts': 'b\n', 'src/c/x.ts': 'c\n' });
  const d = await startTestDaemon();
  try {
    const post = session(d, 'e16', repo);
    const transcript = (agentId: string, tag: string) => {
      const p = path.join(d.home, `agent-${agentId}.jsonl`);
      fs.writeFileSync(p, `${JSON.stringify({ type: 'user', message: { role: 'user', content: `[subtask:${tag}] work\n[scope: src/${tag.toLowerCase()}/**]` } })}\n`);
      return p;
    };
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
    await post(call('A', 'src/a/**'));
    await post(call('B', 'src/b/**'));
    // B's subagent starts first: by order it is taken for A
    await post(start('xb'));
    await post(start('ya'));
    assert.deepEqual(rows(d, "SELECT agent_id, subtask_id, pairing FROM agents ORDER BY started_at, rowid"),
      [{ agent_id: 'xb', subtask_id: 'A', pairing: 'order' }, { agent_id: 'ya', subtask_id: 'B', pairing: 'order' }]);
    write(repo, 'src/b/x.ts', 'b2\n');
    assert.deepEqual(await post(stop('xb', { agent_transcript_path: transcript('xb', 'B') })), {});
    assert.deepEqual(rows(d, "SELECT subtask_id, pairing FROM agents WHERE agent_id = 'xb'"), [{ subtask_id: 'B', pairing: 'confirmed' }]);
    assert.deepEqual(rows(d, "SELECT agent_id, status, verdict FROM subtasks WHERE id = 'B'"), [{ agent_id: 'xb', status: 'passed', verdict: 'meet' }]);
    // before the stop the guard was told the pair came from start order only, so it trusts the transcript tag
    assert.equal(JSON.parse(fs.readFileSync(path.join(d.home, 'agents', 'ya.json'), 'utf8')).pairing, 'order');
    const file = JSON.parse(fs.readFileSync(path.join(d.home, 'agents', 'xb.json'), 'utf8'));
    assert.deepEqual([file.subtaskId, file.pairing, file.scope.allowed], ['B', 'confirmed', ['src/b/**']]);
    write(repo, 'src/a/x.ts', 'a2\n');
    assert.deepEqual(await post(stop('ya', { agent_transcript_path: transcript('ya', 'A') })), {});
    assert.deepEqual(rows(d, "SELECT id, agent_id, status FROM subtasks ORDER BY id"),
      [{ id: 'A', agent_id: 'ya', status: 'passed' }, { id: 'B', agent_id: 'xb', status: 'passed' }]);
    // a transcript already readable at SubagentStart pairs right away
    await post(call('C', 'src/c/**'));
    await post(call('D', 'src/d/**'));
    await post(start('zd', { agent_transcript_path: transcript('zd', 'D') }));
    assert.deepEqual(rows(d, "SELECT subtask_id, pairing FROM agents WHERE agent_id = 'zd'"), [{ subtask_id: 'D', pairing: 'confirmed' }]);
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
});
