// Spec 3.7 data management, 4.4 data minimisation: export (masked JSON lines, prompts only with recordPrompts,
// no raw session ids or tokens) and purge (closed requests and their rows, never an open or awaiting one or
// anything of its session; VACUUM after). Temp homes, loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scopeKey } from '@do-it-all-claude-code/core';
import { AWAITING_USER_MARKER } from '../src/continuation.ts';
import { REQUEST_TABLES, exportLines, isoTime, purge } from '../src/data.ts';
import { homeLayout } from '../src/home.ts';
import { TOKEN, postHook, request, rmrf, rows, startTestDaemon, type HookInput, type TestDaemon } from './helpers.ts';

type Rec = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
const KEY = 'sk-ant-api03-' + 'A'.repeat(40);

async function withDaemon(config: Record<string, unknown>, fn: (d: TestDaemon, clock: { set(iso: string): void }) => Promise<void>): Promise<void> {
  let t = Date.parse('2026-10-01T10:00:00.000Z');
  const d = await startTestDaemon({ now: () => new Date(t), config });
  try { await fn(d, { set: iso => { t = Date.parse(iso); } }); } finally { await d.close(); rmrf(d.home); }
}
const hook = (d: TestDaemon, sid: string, h: HookInput) => postHook(d.port, { session_id: sid, cwd: d.home, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
const prompt = (text: string, id: string): HookInput => ({ hook_event_name: 'UserPromptSubmit', prompt: text, prompt_id: id });
const stop = (msg = 'Done.'): HookInput => ({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: msg });
const exportGet = (d: TestDaemon, q = '', headers: Record<string, string> = {}) => request(d.port, { path: `/router/v1/data/export${q}`, headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
const purgePost = (d: TestDaemon, body: unknown) => request(d.port, {
  method: 'POST', path: '/router/v1/data/purge', body: JSON.stringify(body), headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
});
const lines = (text: string) => text.trim().split('\n').map(l => JSON.parse(l) as Rec);

/** Four sessions: "old" (closed 1 Oct), "new" (closed 20 Oct), "live" (closed 1 Oct, then an open request), "wait" (awaiting the user). */
async function scene(d: TestDaemon, clock: { set(iso: string): void }): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const idOf = (sid: string) => String(rows(d, 'SELECT id FROM requests WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', sid)[0]!.id);
  clock.set('2026-10-01T10:00:00.000Z');
  await hook(d, 'old', prompt('fix the typo in README.md', 'p-old')); ids.old = idOf('old');
  await hook(d, 'old', stop());
  clock.set('2026-10-01T10:05:00.000Z');
  await hook(d, 'live', prompt('rename the helper in src/a.ts', 'p-live-1')); ids.liveClosed = idOf('live');
  await hook(d, 'live', stop());
  clock.set('2026-10-20T10:00:00.000Z');
  await hook(d, 'new', prompt('fix the typo in docs/intro.md', 'p-new')); ids.new = idOf('new');
  await hook(d, 'new', stop());
  await hook(d, 'wait', prompt('update the changelog for 2.0', 'p-wait')); ids.wait = idOf('wait');
  await hook(d, 'wait', stop(`Which version number should I use?\n${AWAITING_USER_MARKER}`));
  clock.set('2026-10-25T10:00:00.000Z');
  await hook(d, 'live', prompt('now add a test for the parser in test/parse.test.ts', 'p-live-2')); ids.liveOpen = idOf('live');
  await d.router.drain();
  assert.notEqual(ids.liveOpen, ids.liveClosed, 'the second prompt opened its own request');
  assert.deepEqual(rows(d, 'SELECT id, status FROM requests ORDER BY created_at, rowid').map(r => [r.id, r.status]),
    [[ids.old, 'closed'], [ids.liveClosed, 'closed'], [ids.new, 'closed'], [ids.wait, 'awaiting_user'], [ids.liveOpen, 'open']]);
  // rows under each request in the other tables
  for (const id of [ids.old, ids.liveClosed, ids.new, ids.liveOpen]) {
    d.ledger.db.prepare("INSERT INTO signals (request_id, subtask_id, agent_id, attempt, kind, ok, detail, created_at) VALUES (?, 'A', 'agent-x', 1, 'test', 0, ?, '2026-10-01T10:00:01.000Z')")
      .run(id, `npm test failed; key ${KEY}; token ${TOKEN}`);
    d.ledger.db.prepare("INSERT INTO costs (request_id, subtask_id, agent_id, source, model_id, usd, created_at) VALUES (?, NULL, NULL, 'lead', 'm', 0.01, '2026-10-01T10:00:01.000Z')").run(id);
    d.ledger.db.prepare("INSERT INTO slots (request_id, role, slot, step, up_count, updated_at) VALUES (?, 'coder', 0, 's1', 0, 't')").run(id);
  }
  d.ledger.db.prepare("INSERT INTO session_limits (session_id, five_hour_pct, updated_at) VALUES ('old', 10, '2026-10-01T10:00:00.000Z'), ('live', 20, '2026-10-01T10:00:00.000Z')").run();
  return ids;
}

test('spec 4.4: export is masked JSON lines of the closed requests: no raw session id, no tokens, no prompt without recordPrompts', () => withDaemon({}, async (d, clock) => {
  const ids = await scene(d, clock);
  d.ledger.db.prepare('UPDATE request_records SET prompt = ? WHERE request_id = ?').run(`fix it, my key is ${KEY}`, ids.old);
  const r = await exportGet(d);
  assert.equal(r.status, 200, r.text);
  assert.match(String(r.headers['content-type']), /^application\/x-ndjson/);
  const [head, ...recs] = lines(r.text);
  assert.deepEqual([head!.type, head!.version, head!.prompts], ['export', 1, false]);
  assert.deepEqual(recs.map(x => x.requestId), [ids.old, ids.liveClosed, ids.new], 'closed requests only, in closing order');
  const old = recs[0]!;
  assert.equal(old.type, 'request');
  assert.match(old.session, /^[0-9a-f]{16}$/);
  assert.ok(!r.text.includes('"old"') && !r.text.includes('"live"'), 'raw session ids stay out');
  assert.equal(old.prompt, undefined, 'recordPrompts is off');
  assert.ok(old.record && old.record.version === 1, 'the T7 record');
  assert.deepEqual(Object.keys(old.signals[0]).sort(), ['attempt', 'createdAt', 'detail', 'kind', 'ok', 'subtaskId']);
  assert.ok(!r.text.includes(KEY) && !r.text.includes(TOKEN) && !r.text.includes('agent-x'), 'keys, the token and agent ids are not exported');
  assert.match(old.signals[0].detail, /\[REDACTED\]/);
  assert.ok(!/five_hour|fiveHour|session_limits/.test(r.text), 'rate-limit usage is not exported');
  // since / until on the closing time; bad dates are refused
  assert.deepEqual(lines((await exportGet(d, '?since=2026-10-10')).text).slice(1).map(x => x.requestId), [ids.new]);
  assert.deepEqual(lines((await exportGet(d, '?until=2026-10-10')).text).slice(1).map(x => x.requestId), [ids.old, ids.liveClosed]);
  assert.equal((await exportGet(d, '?since=yesterday')).status, 400);
  assert.equal((await exportGet(d, '', { origin: `http://127.0.0.1:${d.port}` })).status, 403);
  assert.equal((await request(d.port, { path: '/router/v1/data/export' })).status, 401);
}));

test('spec 3.7: with recordPrompts on, a stored prompt is exported (masked)', () => withDaemon({ recordPrompts: true }, async (d, clock) => {
  await hook(d, 's', prompt(`fix the typo in README.md, the key ${KEY} must not leak`, 'p-1'));
  await hook(d, 's', stop());
  await d.router.drain();
  clock.set('2026-10-02T00:00:00.000Z');
  const [head, rec] = lines((await exportGet(d)).text);
  assert.equal(head!.prompts, true);
  assert.match(rec!.prompt, /^fix the typo in README\.md, the key sk-ant-…\[REDACTED\] must not leak$/);
}));

test('spec 3.7: purge removes closed requests with their rows; open and awaiting requests and their sessions stay intact', () => withDaemon({}, async (d, clock) => {
  const ids = await scene(d, clock);
  const count = (table: string, col: string, id: string) => Number(rows(d, `SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`, id)[0]!.c);
  const liveNull = () => Number(rows(d, "SELECT COUNT(*) AS c FROM events WHERE session_id = 'live' AND request_id IS NULL")[0]!.c);
  const before = { events: count('events', 'request_id', ids.liveOpen), liveNull: liveNull() };
  assert.equal((await purgePost(d, {})).status, 400);
  assert.equal((await purgePost(d, { all: true, before: '2026-10-10' })).status, 400);
  assert.equal((await purgePost(d, { before: 'soon' })).status, 400);
  // a dry run counts and changes nothing
  const dry = (await purgePost(d, { before: '2026-10-10', dryRun: true })).body as Rec;
  assert.deepEqual([dry.dryRun, dry.requests, dry.keptOpen, dry.compacted], [true, 2, 0, false]);
  assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM requests')[0]!.c, 5);
  // before 10 Oct: "old" and the closed request of "live" go; "new" (20 Oct) stays
  const r1 = (await purgePost(d, { before: '2026-10-10' })).body as Rec;
  assert.deepEqual([r1.requests, r1.compacted], [2, true]);
  for (const id of [ids.old, ids.liveClosed]) {
    for (const table of REQUEST_TABLES) assert.equal(count(table, table === 'requests' ? 'id' : 'request_id', id), 0, `${table} of ${id}`);
  }
  assert.deepEqual(rows(d, 'SELECT id FROM requests ORDER BY created_at, rowid').map(r => r.id), [ids.new, ids.wait, ids.liveOpen]);
  assert.deepEqual(rows(d, 'SELECT session_id FROM session_limits').map(r => r.session_id), ['live'], 'a live session\'s limits stay');
  // all: every closed request; the awaiting one, the open one and everything of the "live" session stay
  const r2 = (await purgePost(d, { all: true })).body as Rec;
  assert.deepEqual([r2.requests, r2.keptOpen], [1, 2]);
  assert.deepEqual(rows(d, 'SELECT id, status FROM requests ORDER BY created_at, rowid').map(r => [r.id, r.status]), [[ids.wait, 'awaiting_user'], [ids.liveOpen, 'open']]);
  assert.equal(count('events', 'request_id', ids.liveOpen), before.events);
  assert.equal(liveNull(), before.liveNull, 'events of the live session that belong to no request stay');
  assert.equal(count('signals', 'request_id', ids.liveOpen), 1);
  assert.equal(count('slots', 'request_id', ids.liveOpen), 1);
  assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM request_records')[0]!.c, 0);
  // the open request still works: the user answers the waiting one, and the live one closes and is recorded
  assert.equal((await hook(d, 'live', stop())).status, 200);
  assert.equal((await hook(d, 'wait', prompt('use 2.0.0', 'p-wait-2'))).status, 200);
  await d.router.drain();
  assert.deepEqual(rows(d, 'SELECT request_id FROM request_records').map(r => r.request_id), [ids.liveOpen]);
  assert.equal((await purgePost(d, { all: true })).status, 200);
}));

test('purge covers every ledger table with a request id; isoTime takes a date or a date-time', () => withDaemon({}, async d => {
  const tables = (rows(d, "SELECT name FROM sqlite_master WHERE type = 'table'").map(r => String(r.name)))
    .filter(t => (d.ledger.db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).some(c => c.name === 'request_id' || (t === 'requests' && c.name === 'id')));
  assert.deepEqual([...tables].sort(), [...REQUEST_TABLES].sort(), 'a new table with request_id must be added to REQUEST_TABLES');
  assert.equal(isoTime('2026-10-10'), '2026-10-10T00:00:00.000Z');
  assert.equal(isoTime('2026-10-10T12:30:00+09:00'), '2026-10-10T03:30:00.000Z');
  assert.equal(isoTime('soon'), undefined);
  // the shared functions run on a bare ledger too (the CLI uses them when the daemon is not running)
  assert.deepEqual([...exportLines(d.ledger.db, { includePrompts: false, secrets: [] })].length, 1);
  assert.deepEqual(purge(d.ledger.db, { all: true }), { dryRun: false, requests: 0, keptOpen: 0, rows: {}, compacted: false });
}));

test('decision 142: purge --all also clears the spool, the logs and the scope/agent files and session rows of sessions that are not live', () => withDaemon({}, async (d, clock) => {
  await scene(d, clock);
  const h = homeLayout(d.home);
  for (const dir of [h.spoolDir, h.scopesDir, h.agentsDir, h.logsDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(h.spoolDir, 'x-event-1.jsonl'), '{}\n');
  fs.writeFileSync(path.join(h.scopesDir, `${scopeKey('old', 'A')}.json`), '{}');
  fs.writeFileSync(path.join(h.scopesDir, `${scopeKey('live', 'B')}.json`), '{}');
  fs.writeFileSync(path.join(h.agentsDir, 'a-old.json'), JSON.stringify({ sessionId: 'old' }));
  fs.writeFileSync(path.join(h.agentsDir, 'a-live.json'), JSON.stringify({ sessionId: 'live' }));
  fs.writeFileSync(path.join(h.logsDir, 'proxy.log'), 'a line with a path\n');
  d.ledger.db.exec("INSERT INTO clients (session_id, node, seen_at) VALUES ('old', 'n', 't'), ('live', 'n', 't'); INSERT INTO pending_levels (session_id, level, set_at) VALUES ('old', 'L2', 't')");
  const dry = (await purgePost(d, { all: true, dryRun: true })).body as Rec;
  assert.equal(dry.files.spool, 1);
  assert.ok(fs.existsSync(path.join(h.spoolDir, 'x-event-1.jsonl')), 'a dry run removes nothing');
  const r = (await purgePost(d, { all: true })).body as Rec;
  assert.deepEqual([r.files.spool, r.files.scopes, r.files.agents], [1, 1, 1]);
  assert.ok(r.files.logs >= 1);
  assert.deepEqual(fs.readdirSync(h.spoolDir), []);
  assert.deepEqual(fs.readdirSync(h.scopesDir), [`${scopeKey('live', 'B')}.json`]);
  assert.deepEqual(fs.readdirSync(h.agentsDir), ['a-live.json']);
  assert.equal(fs.statSync(path.join(h.logsDir, 'proxy.log')).size, 0);
  assert.deepEqual(rows(d, 'SELECT session_id FROM clients').map(x => x.session_id), ['live']);
  assert.deepEqual(rows(d, 'SELECT COUNT(*) AS c FROM pending_levels')[0]!.c, 0);
  assert.ok(rows(d, "SELECT COUNT(*) AS c FROM sessions WHERE session_id = 'old'")[0]!.c === 0);
}));
