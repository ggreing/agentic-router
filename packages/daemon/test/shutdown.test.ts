// POST /router/v1/shutdown (decision 66): a sealed call (decisions 156, 164), answer { ok: true } first, kill
// running verify commands, then close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TOKEN, call, makeRepo, postHook, request, rmrf, startTestDaemon, type HookInput } from './helpers.ts';

const SHUTDOWN = '/router/v1/shutdown';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('shutdown needs the token and POST; then answers ok and the daemon stops', async () => {
  const d = await startTestDaemon();
  try {
    assert.equal((await request(d.port, { method: 'POST', path: SHUTDOWN })).status, 401);
    assert.equal((await request(d.port, { method: 'POST', path: SHUTDOWN, headers: { authorization: 'Bearer nope-nope-nope-nope' } })).status, 401);
    assert.equal((await request(d.port, { method: 'POST', path: SHUTDOWN, headers: { authorization: `Bearer ${TOKEN}`, origin: 'http://x' } })).status, 403);
    assert.equal((await request(d.port, { method: 'POST', path: SHUTDOWN, headers: { authorization: `Bearer ${TOKEN}` } })).status, 401, 'the token as a header: refused (decision 164)');
    assert.equal((await call(d.port, { path: SHUTDOWN })).status, 405);

    const r = await call(d.port, { method: 'POST', path: SHUTDOWN });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    await d.closed;
    await assert.rejects(request(d.port, { path: '/router/v1/health' }), /ECONNREFUSED|ECONNRESET/);
    assert.equal(d.ledger.db.isOpen, false);
    assert.match(fs.readFileSync(path.join(d.home, 'logs', 'daemon.log'), 'utf8'), /shutdown requested over the API[\s\S]*daemon stopped/);
  } finally { await d.close(); rmrf(d.home); }
});

test('shutdown kills a running verify command; the waiting stop gets {} and no verdict is recorded', async () => {
  const repo = makeRepo({ 'hang.cjs': 'require("fs").writeFileSync("hang.pid", String(process.pid)); setTimeout(() => {}, 120000);\n' });
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [{ kind: 'test', command: 'node hang.cjs' }] } });
  try {
    const b = { session_id: 'sd', cwd: repo, transcript_path: path.join(repo, 't.jsonl') };
    const post = (h: HookInput) => postHook(d.port, { ...b, ...h });
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the bug where parse() fails on empty input in src/parse.ts' });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: '[subtask:A] x', model: 'haiku', effort: 'low' } });
    await post({ hook_event_name: 'SubagentStart', agent_id: 'ag-h', agent_type: 'do-it-all-claude-code:coder' });
    const stopping = post({ hook_event_name: 'SubagentStop', agent_id: 'ag-h', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false })
      .then(r => r.body, e => `error: ${String(e)}`);

    const pidFile = path.join(repo, 'hang.pid');
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(50);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(alive(pid), 'verify command should be running');

    const t0 = Date.now();
    const r = await call(d.port, { method: 'POST', path: SHUTDOWN });
    assert.deepEqual(r.body, { ok: true });
    assert.deepEqual(await stopping, {});
    await d.closed;
    assert.ok(Date.now() - t0 < 15_000, 'shutdown waited for the verify command instead of killing it');
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
    assert.equal(alive(pid), false, 'verify command still running after shutdown');
    // the ledger was closed after the aborted stop finished; reopen read-only to check nothing was judged
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(d.home, 'router.db'), { readOnly: true });
    try {
      assert.deepEqual({ ...(db.prepare('SELECT status, verdict FROM subtasks').get() as object) }, { status: 'running', verdict: null });
      assert.equal(Number((db.prepare('SELECT COUNT(*) AS c FROM signals').get() as { c: number }).c), 0);
    } finally { db.close(); }
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
});
