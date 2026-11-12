// Decision 149 (delta audit): payloads are masked as parsed values, so what is spooled and stored stays valid
// JSON (audit N1); a lead's edit is posted, spooled and stored by tool name and path only, whatever recordPrompts
// says; a verify signal keeps its structured result and, with recordPrompts off, only its first line; purge --all
// also reaches rotated logs, the limits cache and the dashboard launch page. Temp homes, loopback, fake verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { redact, redactJson } from '@agentic-router/core';
import { exportLines, purgeFiles } from '../src/data.ts';
import { homeLayout } from '../src/home.ts';
import { Ledger } from '../src/ledger.ts';
import { eventPayload } from '../src/payload.ts';
import { testCounts } from '../src/verify.ts';
import { makeHome, makeRepo, postHook, rmrf, rows, startTestDaemon, tmpDir, type HookInput } from './helpers.ts';

type Rec = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
interface Relay {
  relay(raw: string, o: { home: string; write(s: string): void }): Promise<void>;
  redact(s: string): string;
  redactJson(v: unknown): unknown;
  spoolForm(x: unknown, keep: boolean): unknown;
}
const loadRelay = async () => await import(new URL('../../../plugin/hooks/relay.mjs', import.meta.url).href) as Relay;

const KEY = 'sk-ant-api03-' + 'A'.repeat(24);
const PLAIN = '0123456789abcdef';
// a secret at the end of a string, before an escaped quote: masking the serialized document ate the escape and
// the closers after it
const TRICKY = `{"api_key":"${PLAIN}"} then ANTHROPIC_API_KEY=${KEY}"}`;
const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log.';
const FILE_BODY = 'ZQX-file-body-5512';

const closedPort = () => new Promise<number>(resolve => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
const pause = () => new Promise(r => setTimeout(r, 4));   // spool files sort by their millisecond stamp
const onDisk = (db: string) => ['', '-wal', '-shm'].map(x => db + x).filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f).toString('latin1')).join('\n');

test('audit N1: the old way (masking the serialized text) broke this payload; masking the parsed value keeps it valid', () => {
  const doc = { tool_response: { content: [{ type: 'text', text: TRICKY }] } };
  assert.throws(() => JSON.parse(redact(JSON.stringify(doc))), 'the case this guards against');
  const stored = JSON.parse(eventPayload(doc)) as Rec;
  const text = String(stored.tool_response.content[0].text);
  assert.ok(!text.includes(KEY) && !text.includes(PLAIN), text);
  // an oversized payload is stored as a valid marker object, not as cut JSON text
  const big = JSON.parse(eventPayload({ items: Array.from({ length: 40 }, () => 'x'.repeat(1900)) })) as Rec;
  assert.equal(typeof big._truncated, 'number');
  assert.equal(typeof big.preview, 'string');
});

test('audit N1: the relay masks a parsed value exactly as core redactJson does', async () => {
  const relay = await loadRelay();
  const values: unknown[] = [
    { api_key: PLAIN, apiKey: PLAIN, accessToken: PLAIN, clientSecret: PLAIN, password: PLAIN, totalTokens: 1234, monkey: 'banana' },
    { tool_response: { content: [{ type: 'text', text: TRICKY }], nested: [[{ token: 'abc' }], 7, null, true] } },
    ['Authorization: Bearer abcdefghijklmnopqrstuvwx', `key ${KEY}`, 'nothing here'],
    'ghp_0123456789abcdefghijABCDEFGHIJ', 42, null,
  ];
  for (const v of values) assert.deepEqual(relay.redactJson(v), redactJson(v), JSON.stringify(v));
  assert.equal(relay.redact('x'.repeat(1_000_005)), redact('x'.repeat(1_000_005)), 'the same length bound');
});

test('audit N1: with the daemon down an Agent result is spooled as valid JSON, replayed, and the request record survives', async () => {
  const relay = await loadRelay();
  const home = makeHome({ daemonPort: await closedPort(), recordPrompts: true });
  const repo = makeRepo({ 'src/a.ts': 'a\n' });
  const out: string[] = [];
  const hook = async (o: HookInput) => {
    await relay.relay(JSON.stringify({ session_id: 'n1', cwd: repo, transcript_path: path.join(home, 'n1.jsonl'), ...o }), { home, write: s => { out.push(s); } });
    await pause();
  };
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT, prompt_id: 'p-1' });
  await hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1',
    tool_input: { subagent_type: 'agentic-router:coder', prompt: '[subtask:A] add the audit log\n[scope: src/**]\nThe spec.', model: 'haiku', effort: 'low' } });
  await hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'agentic-router:coder' });
  await hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { subagent_type: 'agentic-router:coder', prompt: '[subtask:A] add the audit log' },
    tool_response: { status: 'async_launched', agentId: 'a1', isAsync: true, content: [{ type: 'text', text: TRICKY }] } });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'audited\n');
  await hook({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'agentic-router:coder', stop_hook_active: false, last_assistant_message: `- Changed files: src/a.ts\n${TRICKY}` });
  await hook({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p-2',
    prompt: `<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<result>${TRICKY}</result>\n</task-notification>` });
  await hook({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: `Done. ${TRICKY}` });
  assert.equal(out.length, 7);
  const spoolDir = path.join(home, 'spool');
  const files = fs.readdirSync(spoolDir).sort();
  assert.equal(files.length, 7);
  for (const f of files) {
    const text = fs.readFileSync(path.join(spoolDir, f), 'utf8');
    assert.ok(!text.includes(KEY) && !text.includes(PLAIN), f);
    assert.doesNotThrow(() => JSON.parse(text), `${f} is one valid JSON record`);
  }
  const d = await startTestDaemon({ home, verify: { resolveCommands: async () => [] } });
  try {
    assert.equal(d.replay.events, 7);
    await d.router.drain();
    for (const r of rows(d, 'SELECT id, payload FROM events')) assert.doesNotThrow(() => JSON.parse(String(r.payload)), `event ${String(r.id)}`);
    const recs = rows(d, "SELECT record FROM request_records WHERE session_id = 'n1'");
    assert.equal(recs.length, 1, 'the request closed and its record was written');
    assert.equal((JSON.parse(String(recs[0]!.record)) as Rec).subtasks.length, 1);
  } finally { await d.close(); }
  const db = onDisk(homeLayout(home).db);
  assert.ok(!db.includes(KEY) && !db.includes(PLAIN), 'no secret anywhere in the ledger file');
  rmrf(home); rmrf(repo);
});

test('decision 149: a lead edit is posted, spooled and stored by path only, even with recordPrompts on', async () => {
  const relay = await loadRelay();
  const edit = { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'tw', tool_input: { file_path: 'src/a.ts', content: FILE_BODY },
    tool_response: { filePath: 'src/a.ts', content: FILE_BODY, structuredPatch: [{ lines: [`+${FILE_BODY}`] }] } };
  const spooled = JSON.stringify(relay.spoolForm(edit, true));
  assert.ok(!spooled.includes(FILE_BODY) && spooled.includes('src/a.ts'), spooled);
  // what the relay posts: a stub daemon records the body
  const bodies: string[] = [];
  const stub = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += String(c); }); req.on('end', () => { bodies.push(b); res.setHeader('content-type', 'application/json'); res.end('{}'); });
  });
  await new Promise<void>(r => stub.listen(0, '127.0.0.1', r));
  const home = makeHome({ daemonPort: (stub.address() as { port: number }).port, recordPrompts: true });
  try {
    await relay.relay(JSON.stringify({ session_id: 'le', cwd: home, transcript_path: path.join(home, 'le.jsonl'), ...edit }), { home, write: () => {} });
    assert.equal(bodies.length, 1);
    assert.ok(!bodies[0]!.includes(FILE_BODY) && bodies[0]!.includes('src/a.ts'), bodies[0]);
  } finally { await new Promise(r => stub.close(r)); rmrf(home); }
  // and what the daemon stores when a full edit reaches it anyway (an older relay)
  const d = await startTestDaemon({ config: { recordPrompts: true }, verify: { resolveCommands: async () => [] } });
  try {
    const repo = makeRepo({ 'src/a.ts': 'a\n' });
    const post = (h: HookInput) => postHook(d.port, { session_id: 'le2', cwd: repo, transcript_path: path.join(d.home, 'le2.jsonl'), ...h });
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the typo in README.md', prompt_id: 'p-1' });
    await post(edit as unknown as HookInput);
    await d.router.drain();
    const stored = rows(d, "SELECT payload FROM events WHERE tool_name = 'Write'").map(r => String(r.payload));
    assert.ok(stored.length >= 1);
    for (const p of stored) assert.ok(!p.includes(FILE_BODY) && p.includes('src/a.ts'), p);
    rmrf(repo);
  } finally { await d.close(); rmrf(d.home); }
});

test('decision 149: test runner summaries become pass and fail counts; nothing else leaves the output', () => {
  assert.deepEqual(testCounts('ℹ tests 12\nℹ pass 11\nℹ fail 1\n'), { testsPassed: 11, testsFailed: 1 });
  assert.deepEqual(testCounts('# tests 3\n# pass 3\n# fail 0\n'), { testsPassed: 3, testsFailed: 0 });
  assert.deepEqual(testCounts('==== 2 failed, 40 passed in 1.2s ===='), { testsPassed: 40, testsFailed: 2 });
  assert.deepEqual(testCounts('Tests:       1 failed, 9 passed, 10 total'), { testsPassed: 9, testsFailed: 1 });
  assert.deepEqual(testCounts('  14 passing (30ms)\n  2 failing'), { testsPassed: 14, testsFailed: 2 });
  assert.deepEqual(testCounts('first run: 3 passed\nretry: 5 passed'), { testsPassed: 5 }, 'the last summary');
  assert.deepEqual(testCounts('compiled 12 files'), {});
});

test('decision 149: a verify signal keeps its structured result; the output tail only with recordPrompts on (and v15 trims old rows)', () => {
  const dir = tmpDir('sig15');
  const file = path.join(dir, 'router.db');
  const ctx = { requestId: 'r1', subtaskId: 'A', agentId: 'a1', attempt: 1, at: '2026-11-01T00:00:00.000Z' };
  const sig = { kind: 'test' as const, ok: false, detail: `npm test: exit 1\nnot ok 3 - ${FILE_BODY}`, exitCode: 1, durationMs: 1234.4, testsPassed: 2, testsFailed: 1 };
  let l: Ledger | undefined;
  try {
    l = new Ledger(file, { keepPrompts: true });
    l.insertSignals(ctx, [sig]);
    assert.equal(String((l.db.prepare('SELECT detail FROM signals').get() as Rec).detail), sig.detail, 'recordPrompts on: the tail is kept');
    l.close();
    l = new Ledger(file);   // recordPrompts off now: the stored tail goes at open
    l.insertSignals({ ...ctx, attempt: 2 }, [sig]);
    const got = l.db.prepare('SELECT attempt, detail, exit_code, duration_ms, tests_passed, tests_failed FROM signals ORDER BY attempt').all() as Rec[];
    assert.deepEqual(got.map(r => ({ ...r })), [
      { attempt: 1, detail: 'npm test: exit 1', exit_code: 1, duration_ms: 1234, tests_passed: 2, tests_failed: 1 },
      { attempt: 2, detail: 'npm test: exit 1', exit_code: 1, duration_ms: 1234, tests_passed: 2, tests_failed: 1 },
    ]);
    // the export carries the structured result
    l.db.exec(`INSERT INTO request_records (request_id, session_id, created_at, closed_at, level, final_level, record, prompt)
      VALUES ('r1', 's', '2026-11-01T00:00:00.000Z', '2026-11-01T00:01:00.000Z', 'L2', 'L2', '{}', NULL)`);
    const req = [...exportLines(l.db, { includePrompts: false })].map(x => JSON.parse(x) as Rec).find(x => x.type === 'request')!;
    assert.deepEqual(req.signals[0], { subtaskId: 'A', attempt: 1, kind: 'test', ok: false, detail: 'npm test: exit 1', createdAt: ctx.at,
      exitCode: 1, durationMs: 1234, testsPassed: 2, testsFailed: 1 });
    l.close(); l = undefined;
    assert.ok(!onDisk(file).includes(FILE_BODY), 'the tail is nowhere in the file');
  } finally { l?.close(); rmrf(dir); }
});

test('decision 149: purge --all deletes rotated logs, the limits cache of sessions that are not live and the dashboard launch page; never through a link', () => {
  const root = tmpDir('purge149');
  const h = homeLayout(root);
  for (const dir of [h.spoolDir, h.scopesDir, h.agentsDir, h.logsDir, path.join(root, 'limits-cache')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(h.logsDir, 'daemon.log'), 'current\n');
  fs.writeFileSync(path.join(h.logsDir, 'daemon.log.1'), 'rotated\n');
  fs.writeFileSync(path.join(h.logsDir, 'proxy.log.2'), 'rotated\n');
  fs.writeFileSync(path.join(root, 'limits-cache', 'old-session.json'), '{}');
  fs.writeFileSync(path.join(root, 'limits-cache', 'live_session.json'), '{}');
  fs.writeFileSync(path.join(root, 'dashboard-open.html'), '<html>token</html>');
  // a folder elsewhere linked in as the spool: purge must not empty it
  const elsewhere = tmpDir('elsewhere');
  fs.writeFileSync(path.join(elsewhere, 'keep.jsonl'), '{}\n');
  fs.rmSync(h.spoolDir, { recursive: true });
  let linked = true;
  try { fs.symlinkSync(elsewhere, h.spoolDir, 'junction'); } catch { linked = false; fs.mkdirSync(h.spoolDir); }
  try {
    const dry = purgeFiles({ ...h, root }, new Set(['live:session']), true);
    assert.deepEqual([dry.logs, dry.limitsCache, dry.launchPage], [3, 1, 1]);
    assert.ok(fs.existsSync(path.join(h.logsDir, 'daemon.log.1')), 'a dry run removes nothing');
    const r = purgeFiles({ ...h, root }, new Set(['live:session']));
    assert.deepEqual([r.logs, r.limitsCache, r.launchPage, r.spool], [3, 1, 1, undefined]);
    assert.deepEqual(fs.readdirSync(h.logsDir), ['daemon.log']);
    assert.equal(fs.statSync(path.join(h.logsDir, 'daemon.log')).size, 0);
    assert.deepEqual(fs.readdirSync(path.join(root, 'limits-cache')), ['live_session.json'], 'the live session keeps its stamp');
    assert.ok(!fs.existsSync(path.join(root, 'dashboard-open.html')));
    if (linked) assert.ok(fs.existsSync(path.join(elsewhere, 'keep.jsonl')), 'nothing deleted through the link');
  } finally {
    // removes the link itself, not what it points to: a symlink is unlinked, a Windows junction is a directory
    if (linked) { try { fs.unlinkSync(h.spoolDir); } catch { fs.rmdirSync(h.spoolDir); } }
    rmrf(root); rmrf(elsewhere);
  }
});

