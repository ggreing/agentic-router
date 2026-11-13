import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadSpike, makeHome, makeRepo, retarget, rmrf, rows, startTestDaemon } from './helpers.ts';

// receivedAt values relative to now: replay drops events older than 24 h (decision 100), so fixed dates
// would turn these tests into a time bomb
const BASE = Date.now() - 60 * 60 * 1000;
const at = (sec: number) => new Date(BASE + sec * 1000).toISOString();
const stamp = (sec: number) => at(sec).replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');

test('spool is replayed in name order before the daemon listens; replayed events are recorded only', async () => {
  const repo = makeRepo();
  const home = makeHome();
  let verifyCalls = 0;
  try {
    const s2 = retarget(loadSpike('s2'), repo);
    const take = (name: string) => s2.find(h => h.hook_event_name === name)!;
    const spool = path.join(home, 'spool');
    fs.mkdirSync(spool, { recursive: true });
    const line = (input: unknown, receivedAt: string) => JSON.stringify({ receivedAt, input });
    // an interrupted earlier replay goes first
    fs.writeFileSync(path.join(spool, `${stamp(-1800)}-1.jsonl.replaying`),
      line({ session_id: 'older', hook_event_name: 'SessionStart', cwd: repo, source: 'startup' }, at(-1800)) + '\n');
    fs.writeFileSync(path.join(spool, `${stamp(0)}-2.jsonl`), [
      line(take('SessionStart'), at(0)),
      line(take('UserPromptSubmit'), at(1)),
      line(take('PreToolUse'), at(2)),
      line(take('SubagentStart'), at(3)),
      '{"this is": not json',
      line(take('SubagentStop'), at(4)),
      JSON.stringify(take('Stop')),                                        // a bare hook input line
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(spool, 'notes.txt'), 'not a spool file');

    const d = await startTestDaemon({ home, verify: { resolveCommands: async () => { verifyCalls++; return []; } } });
    try {
      assert.deepEqual(d.replay, { files: 2, events: 7, errors: 1, dropped: 0 });
      assert.deepEqual(fs.readdirSync(spool), ['notes.txt']);
      const evs = rows(d, 'SELECT session_id, type, spooled, received_at FROM events ORDER BY id');
      assert.equal(evs.length, 7);
      assert.equal(evs[0]!.session_id, 'older');
      assert.deepEqual(evs.map(e => e.type), ['session_start', 'session_start', 'prompt_submit', 'pre_tool_use', 'subagent_start', 'subagent_stop', 'stop']);
      assert.ok(evs.every(e => e.spooled === 1));
      assert.equal(evs[2]!.received_at, at(1));
      // the ledger is consistent (request, subtask paired), but nothing was verified or blocked
      assert.deepEqual(rows(d, 'SELECT status FROM requests'), [{ status: 'closed' }]);
      // decision 89: the replayed stop of a router subagent is recorded as unverified, for the lead to check
      assert.deepEqual(rows(d, 'SELECT id, status, verdict FROM subtasks'), [{ id: 'C', status: 'hitl', verdict: 'unverified' }]);
      assert.equal(verifyCalls, 0);
      assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM signals')[0]!.c, 0);
      assert.ok(rows(d, 'SELECT stopped_at FROM agents')[0]!.stopped_at);
      const log = fs.readFileSync(path.join(home, 'logs', 'daemon.log'), 'utf8');
      assert.match(log, /spool line skipped/);
      assert.match(log, /spool replayed/);
    } finally { await d.close(); }
  } finally { rmrf(home); rmrf(repo); }
});

test('a spooled Agent call that breaks the rules is recorded, not denied after the fact', async () => {
  const home = makeHome();
  try {
    const spool = path.join(home, 'spool');
    fs.mkdirSync(spool, { recursive: true });
    fs.writeFileSync(path.join(spool, 'a.jsonl'), JSON.stringify({ receivedAt: at(0), input: {
      session_id: 's', hook_event_name: 'PreToolUse', cwd: home, tool_name: 'Agent',
      tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: '[subtask:A] x', model: 'opus', effort: 'xhigh' },
    } }) + '\n');
    const d = await startTestDaemon({ home });
    try {
      assert.equal(d.replay.events, 1);
      assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM subtasks')[0]!.c, 0);
      assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM events WHERE spooled = 1')[0]!.c, 1);
    } finally { await d.close(); }
  } finally { rmrf(home); }
});
