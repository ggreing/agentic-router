// Decision 141 (spec 4.4 data minimisation): with recordPrompts off no conversation text is stored in events
// (prompts, task notifications, /compact instructions, last messages), old rows are scrubbed when the ledger
// opens, and events older than eventRetentionDays are dropped outside live sessions. The checks read the raw
// SQLite files, not just the rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { pruneEvents, scrubProse } from '../src/data.ts';
import { minimalPayload } from '../src/payload.ts';
import { homeLayout } from '../src/home.ts';
import { Ledger, SCHEMA_VERSION } from '../src/ledger.ts';
import { makeHome, makeRepo, postHook, rmrf, rows, startTestDaemon, tmpDir, type HookInput, type TestDaemon } from './helpers.ts';

const MARK = 'ZQX-private-7781';
const L2_PROMPT = `Refactor the validation module across multiple files and add an audit log. ${MARK}`;
type Rec = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

/** Every byte of the ledger on disk (the database and, if present, its WAL and shared memory). */
function onDisk(db: string): string {
  return ['', '-wal', '-shm'].map(x => db + x).filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f).toString('latin1')).join('\n');
}

/** A delegated request whose every conversation field carries MARK; returns the daemon's ledger file. */
async function fullFlow(config: Record<string, unknown>): Promise<{ db: string; record: Rec; prompts: Rec[]; cleanup(): void }> {
  const repo = makeRepo({ 'src/a.ts': 'a\n' });
  const d: TestDaemon = await startTestDaemon({ config, verify: { resolveCommands: async () => [] } });
  const post = async (h: HookInput) => {
    const r = await postHook(d.port, { session_id: 's1', cwd: repo, transcript_path: path.join(d.home, 's1.jsonl'), ...h });
    assert.equal(r.status, 200, r.text);
  };
  await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT, prompt_id: 'p-1' });
  await post({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1',
    tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: `[subtask:A] add the audit log ${MARK}\n[scope: src/**]\nThe spec: ${MARK}`, model: 'haiku', effort: 'low' } });
  await post({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'do-it-all-claude-code:coder' });
  // the async launch result: it repeats the spec and carries a description
  await post({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: `[subtask:A] ${MARK}` },
    tool_response: { status: 'async_launched', agentId: 'a1', isAsync: true, description: `audit ${MARK}`, prompt: `[subtask:A] ${MARK}`, content: [{ type: 'text', text: `launched ${MARK}` }] } });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'audited\n');
  await post({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false, last_assistant_message: `- Changed files: src/a.ts ${MARK}` });
  await post({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p-2',
    prompt: `<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<result>done, as asked: ${MARK}</result>\n</task-notification>` });
  await post({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: `keep the audit log notes ${MARK}` });
  await post({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: `Done: the audit log is in. ${MARK}` });
  await d.router.drain();
  const record = JSON.parse(String(rows(d, 'SELECT record FROM request_records')[0]!.record)) as Rec;
  const prompts = rows(d, "SELECT payload FROM events WHERE type = 'prompt_submit' ORDER BY id").map(r => JSON.parse(String(r.payload)) as Rec);
  const db = homeLayout(d.home).db;
  await d.close();                                    // the WAL is checkpointed into the file on close
  return { db, record, prompts, cleanup: () => { rmrf(d.home); rmrf(repo); } };
}

test('decision 141: with recordPrompts off, no conversation text is anywhere in the ledger file after a full delegated request', async () => {
  const f = await fullFlow({});
  try {
    assert.ok(!onDisk(f.db).includes(MARK), 'the marker is nowhere in router.db, its WAL or its shared memory');
    // what the readers use is still there: prompt ids, the notification flag, the lengths
    assert.deepEqual(f.prompts.map(p => [p.prompt_id, p.prompt_kind, typeof p.prompt_chars, 'prompt' in p]),
      [['p-1', 'user', 'number', false], ['p-2', 'notification', 'number', true]]);
    assert.equal(f.prompts[1]!.prompt, '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>', 'the tags a replay needs, not the result');
    assert.equal(f.record.turns.notifications, 1, 'the request record still counts the task notification');
    assert.equal(f.record.subtasks.length, 1);
  } finally { f.cleanup(); }
});

test('decision 141: with recordPrompts on, the text is kept (the user opted in)', async () => {
  const f = await fullFlow({ recordPrompts: true });
  try {
    assert.ok(onDisk(f.db).includes(MARK));
    assert.match(String(f.prompts[0]!.prompt), new RegExp(MARK));
  } finally { f.cleanup(); }
});

test('decision 141: opening a ledger with recordPrompts off scrubs rows written before (v13), cut payloads included', () => {
  const dir = tmpDir('ar-v12-');
  const file = path.join(dir, 'router.db');
  let opened: Ledger | undefined;
  try {
    const old = new Ledger(file, { keepPrompts: true });
    const ins = old.db.prepare("INSERT INTO events (session_id, request_id, agent_id, type, tool_name, received_at, spooled, payload) VALUES ('s', NULL, NULL, ?, NULL, '2026-10-01T00:00:00.000Z', 0, ?)");
    ins.run('prompt_submit', JSON.stringify({ session_id: 's', prompt: `fix it ${MARK}`, prompt_id: 'p-1' }));
    const notification = `<task-notification>\n<result>${MARK}</result>\n</task-notification>`;
    const cut = `{"session_id":"s","prompt_id":"p-3","prompt":"${'x'.repeat(50)} ${MARK}…[truncated 900 chars]`;   // cut at the size limit
    ins.run('prompt_submit', JSON.stringify({ session_id: 's', prompt: notification, prompt_id: 'p-2' }));
    ins.run('stop', JSON.stringify({ session_id: 's', last_assistant_message: `answer ${MARK}` }));
    ins.run('pre_compact', JSON.stringify({ session_id: 's', custom_instructions: `notes ${MARK}` }));
    ins.run('prompt_submit', cut);
    ins.run('pre_tool_use', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    old.db.exec('PRAGMA user_version = 12');
    old.close();
    assert.ok(onDisk(file).includes(MARK), 'the old rows carry the text');
    const l = new Ledger(file);
    opened = l;
    assert.equal(Number((l.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), SCHEMA_VERSION);
    const got = (l.db.prepare('SELECT type, payload FROM events ORDER BY id').all() as Array<{ type: string; payload: string }>).map(r => [r.type, JSON.parse(r.payload)]);
    assert.deepEqual(got, [
      ['prompt_submit', { _min: 1, session_id: 's', prompt_id: 'p-1', prompt_chars: `fix it ${MARK}`.length, prompt_kind: 'user' }],
      ['prompt_submit', { _min: 1, session_id: 's', prompt_id: 'p-2', prompt_chars: notification.length, prompt_kind: 'notification', prompt: '<task-notification>\n</task-notification>' }],
      ['stop', { _min: 1, session_id: 's', last_assistant_message_chars: `answer ${MARK}`.length }],
      ['pre_compact', { _min: 1, session_id: 's', custom_instructions_chars: `notes ${MARK}`.length }],
      ['prompt_submit', { _min: 1, payload_unreadable: true, chars: cut.length, prompt_id: 'p-3' }],
      ['pre_tool_use', { _min: 1, tool_name: 'Bash', tool_input: {} }],      // decision 142: tool inputs go too (only the Agent dispatch lines stay)
    ]);
    // the readers still tell a notification from a user prompt on the scrubbed rows
    l.db.exec("UPDATE events SET request_id = 'r' WHERE type = 'prompt_submit'");
    assert.deepEqual(l.promptEvents('r'), [{ promptId: 'p-1', notification: false }, { promptId: 'p-2', notification: true }, { promptId: 'p-3', notification: false }]);
    assert.equal(l.userPromptAfter('s', 0), true);
    assert.equal(scrubProse(l.db), 0, 'nothing left to scrub');
    l.close();
    assert.ok(!onDisk(file).includes(MARK), 'and the old text is gone from the file too');
  } finally { opened?.close(); rmrf(dir); }
});

test('decision 141: retention drops old events at daemon start, but none of a session with an open request', async () => {
  const home = makeHome({ eventRetentionDays: 30 });
  const l = new Ledger(homeLayout(home).db);
  const ins = l.db.prepare("INSERT INTO events (session_id, request_id, agent_id, type, tool_name, received_at, spooled, payload) VALUES (?, NULL, NULL, 'session_start', NULL, ?, 0, '{}')");
  ins.run('old', '2026-09-01T00:00:00.000Z');
  ins.run('live', '2026-09-01T00:00:00.000Z');
  ins.run('recent', '2026-11-08T00:00:00.000Z');
  l.db.prepare(`INSERT INTO requests (id, session_id, created_at, level, preset, budget_usd, triage, team, status) VALUES ('r-live', 'live', '2026-09-01T00:00:00.000Z', 'L1', 'p', 1, '{}', '{}', 'awaiting_user')`).run();
  l.close();
  const d = await startTestDaemon({ home, now: () => new Date('2026-11-12T12:00:00.000Z') });
  try {
    assert.deepEqual(rows(d, 'SELECT session_id FROM events ORDER BY id').map(r => r.session_id), ['live', 'recent']);
    // the rule itself: 0 keeps everything; a later day drops "recent" too once the session is not live
    assert.equal(pruneEvents(d.ledger.db, 0, '2027-01-01T00:00:00.000Z'), 0);
    assert.equal(pruneEvents(d.ledger.db, 30, '2027-01-01T00:00:00.000Z'), 1);
    assert.deepEqual(rows(d, 'SELECT session_id FROM events').map(r => r.session_id), ['live']);
  } finally { await d.close(); rmrf(d.home); }
  // the setting: default 30, 0 allowed, anything else warned about and replaced by the default
  const cfg = (o: unknown) => { const dir = tmpDir('ar-cfg-'); const f = path.join(dir, 'config.json'); fs.writeFileSync(f, JSON.stringify({ daemonPort: 1, ...(o as object) })); const w: string[] = []; const c = readConfig(f, w); rmrf(dir); return [c.eventRetentionDays, w.length]; };
  assert.deepEqual(cfg({}), [30, 0]);
  assert.deepEqual(cfg({ eventRetentionDays: 0 }), [0, 0]);
  assert.deepEqual(cfg({ eventRetentionDays: 7 }), [7, 0]);
  assert.deepEqual(cfg({ eventRetentionDays: 1.5 }), [30, 1]);
  assert.deepEqual(cfg({ eventRetentionDays: -1 }), [30, 1]);
});

test('decision 142: the minimal form keeps what routing and a replay need, nothing else, and is idempotent', () => {
  type P = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  const spec = `[subtask:A] the spec ${MARK}\n[scope: src/**, test/**]\nthen ${MARK}`;
  const agent = minimalPayload({
    hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Agent', tool_use_id: 'toolu_1', cwd: '/repo',
    tool_input: { subagent_type: 'do-it-all-claude-code:coder', model: 'haiku', effort: 'low', description: `audit ${MARK}`, prompt: spec },
  });
  assert.deepEqual(agent, { _min: 1, hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Agent', tool_use_id: 'toolu_1', cwd: '/repo',
    tool_input: { subagent_type: 'do-it-all-claude-code:coder', model: 'haiku', effort: 'low', prompt_chars: spec.length, prompt: '[subtask:A]\n[scope: src/**, test/**]' } });
  // the positions the router parses by: a scope without a tag stays on line 2
  assert.equal((minimalPayload({ tool_name: 'Agent', tool_input: { prompt: `do it ${MARK}\n[scope: src/**]` } }) as Record<string, any>).tool_input.prompt, '\n[scope: src/**]');   // eslint-disable-line @typescript-eslint/no-explicit-any
  const tagged = minimalPayload({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: `[subtask:B]\n[scope: src/**]\n${MARK}` } }) as P;
  assert.equal(tagged.tool_input.prompt, '[subtask:B]\n[scope: src/**]', 'the tag and scope lines a replayed dispatch binds by');
  const report = `report ${MARK}`;
  const result = minimalPayload({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { prompt: MARK },
    tool_response: { status: 'completed', agentId: 'a1', totalTokens: 900, prompt: MARK, content: [{ type: 'text', text: report }] } }) as P;
  assert.deepEqual(result.tool_response, { status: 'completed', agentId: 'a1', totalTokens: 900, text_chars: report.length });
  const note = minimalPayload({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p', prompt: '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n'
    + `<summary>${MARK}</summary>\n<result>${MARK}</result>\n`
    + '<worktree><worktreePath>/r/.claude/worktrees/agent-a1</worktreePath><worktreeBranch>worktree-agent-a1</worktreeBranch></worktree>\n'
    + '<usage><subagent_tokens>1200</subagent_tokens><tool_uses>7</tool_uses><duration_ms>5000</duration_ms></usage>\n</task-notification>' }) as P;
  assert.equal(note.prompt, '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n'
    + '<worktree><worktreePath>/r/.claude/worktrees/agent-a1</worktreePath><worktreeBranch>worktree-agent-a1</worktreeBranch></worktree>\n'
    + '<usage><subagent_tokens>1200</subagent_tokens><tool_uses>7</tool_uses><duration_ms>5000</duration_ms></usage>\n</task-notification>');
  const waiting = minimalPayload({ hook_event_name: 'Stop', last_assistant_message: `Which one? ${MARK}\n[router:awaiting-user]` }) as P;
  assert.equal(waiting.last_assistant_message, '[router:awaiting-user]', 'the marker alone, so a replay still waits for the user');
  const env = minimalPayload({ hook_event_name: 'SubagentStart', agent_id: 'a1', verifyEnv: { VIRTUAL_ENV: '/v', PATH: '/x' } }) as P;
  assert.deepEqual(env.verifyEnv, ['PATH', 'VIRTUAL_ENV']);
  for (const p of [agent, tagged, result, note, waiting, env]) {
    assert.ok(!JSON.stringify(p).includes(MARK));
    assert.deepEqual(minimalPayload(JSON.parse(JSON.stringify(p))), p, 'reducing again changes nothing');
  }
});

test('decision 142: the relay\'s copy of the minimal form equals the daemon\'s on every recorded hook input', async () => {
  const relay = await import(new URL('../../../plugin/hooks/relay.mjs', import.meta.url).href) as { minimalHookInput(x: unknown): unknown; spoolForm(x: unknown, keep: boolean): unknown };
  const fixtures = fileURLToPath(new URL('../../adapter-claude-code/test/fixtures/', import.meta.url));
  const inputs: unknown[] = [];
  for (const f of fs.readdirSync(fixtures).filter(x => /^spike-.*\.jsonl$/.test(x))) {
    for (const line of fs.readFileSync(path.join(fixtures, f), 'utf8').split(/\r?\n/).filter(Boolean)) {
      try { const o = JSON.parse(line) as { input?: unknown }; if (o.input) inputs.push(o.input); } catch { /* not a recorded hook line */ }
    }
  }
  inputs.push(
    { hook_event_name: 'SubagentStart', agent_id: 'a', verifyEnv: { PATH: '/x', VIRTUAL_ENV: '/v' } },
    { hook_event_name: 'Stop', last_assistant_message: `x ${MARK} [router:awaiting-user]` },
    { hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_do-it-all-claude-code_router__router_report_result', tool_input: { subtaskId: 'A', verdict: 'accept' } },
  );
  assert.ok(inputs.length > 20, `recorded inputs: ${inputs.length}`);
  for (const i of inputs) {
    assert.deepEqual(relay.minimalHookInput(i), minimalPayload(i));
    assert.deepEqual(relay.minimalHookInput(relay.minimalHookInput(i)), relay.minimalHookInput(i));
  }
  // recordPrompts on: the spool keeps the input, but verify-env names only
  assert.deepEqual(relay.spoolForm({ hook_event_name: 'SubagentStart', prompt: 'p', verifyEnv: { B: '2', A: '1' } }, true), { hook_event_name: 'SubagentStart', prompt: 'p', verifyEnv: ['A', 'B'] });
});

test('decision 142: with the daemon down the relay spools the minimal form (0600), and the replay still routes by it', async () => {
  const relay = await import(new URL('../../../plugin/hooks/relay.mjs', import.meta.url).href) as { relay(raw: string, o: { home: string; write(s: string): void }): Promise<void> };
  const net = await import('node:net');
  const closed = await new Promise<number>(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
  const home = makeHome({ daemonPort: closed });
  const out: string[] = [];
  const hook = (o: Record<string, unknown>) => relay.relay(JSON.stringify({ session_id: 'sp', cwd: home, transcript_path: path.join(home, 'sp.jsonl'), ...o }), { home, write: s => { out.push(s); } });
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: `fix the typo in README.md ${MARK}`, prompt_id: 'p-1' });
  await hook({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: `Which file? ${MARK}\n[router:awaiting-user]` });
  assert.deepEqual(out, ['{}', '{}'], 'the hooks passed');
  const spoolDir = path.join(home, 'spool');
  const files = fs.readdirSync(spoolDir);
  assert.equal(files.length, 2);
  for (const f of files) {
    assert.ok(!fs.readFileSync(path.join(spoolDir, f), 'utf8').includes(MARK), f);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(spoolDir, f)).mode & 0o777, 0o600);
  }
  const d = await startTestDaemon({ home });
  try {
    assert.equal(d.replay.events, 2);
    // replayed from the minimal form: the request exists and waits for the user (the marker came through)
    assert.deepEqual(rows(d, "SELECT prompt_id, status FROM requests WHERE session_id = 'sp'"), [{ prompt_id: 'p-1', status: 'awaiting_user' }]);
  } finally { await d.close(); }
  assert.ok(!onDisk(homeLayout(home).db).includes(MARK));
  rmrf(home);
});

test('decision 142: the relay masks with the generated secret-patterns.json exactly as core redact does', async () => {
  const { redact } = await import('@do-it-all-claude-code/core');
  const relay = await import(new URL('../../../plugin/hooks/relay.mjs', import.meta.url).href) as { redact(s: string): string };
  const samples = [
    'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA and more', 'Authorization: Bearer abcdefghijklmnopqrstuvwx', '{"api_key":"0123456789abcdef"}',
    'ghp_0123456789abcdefghijABCDEFGHIJ', 'AKIA0123456789ABCDEF', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlMTIz',
    'ANTHROPIC_API_KEY=sk-ant-xyz12345678', 'xoxb-1234567890-abcdefgh', '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', 'nothing here',
  ];
  for (const s of samples) assert.equal(relay.redact(s), redact(s), s);
});

test('decision 142: switching recordPrompts off deletes the prompt text kept while it was on, at the next ledger open', () => {
  const dir = tmpDir('ar-prompts-');
  const file = path.join(dir, 'router.db');
  let l: Ledger | undefined;
  try {
    l = new Ledger(file, { keepPrompts: true });
    l.db.exec(`INSERT INTO requests (id, session_id, created_at, level, preset, budget_usd, triage, team, status, prompt_text)
      VALUES ('r1', 's', '2026-11-01T00:00:00.000Z', 'L1', 'p', 1, '{}', '{}', 'closed', 'fix it ${MARK}')`);
    l.db.exec(`INSERT INTO request_records (request_id, session_id, created_at, closed_at, level, final_level, record, prompt)
      VALUES ('r1', 's', '2026-11-01T00:00:00.000Z', '2026-11-01T00:01:00.000Z', 'L1', 'L1', '{}', 'fix it ${MARK}')`);
    l.close();
    l = new Ledger(file, { keepPrompts: true });                 // still on: kept
    const stored = (x: Ledger) => [(x.db.prepare('SELECT prompt_text AS p FROM requests').get() as { p: unknown }).p, (x.db.prepare('SELECT prompt AS p FROM request_records').get() as { p: unknown }).p];
    assert.deepEqual(stored(l), [`fix it ${MARK}`, `fix it ${MARK}`]);
    l.close();
    l = new Ledger(file);                                        // switched off
    assert.deepEqual(stored(l), [null, null]);
    l.close();
    l = undefined;
    assert.ok(!onDisk(file).includes(MARK), 'and gone from the file');
  } finally { l?.close(); rmrf(dir); }
});
