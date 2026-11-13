// `do-it-all-claude-code data export | purge` (spec 3.7, 4.4): through the daemon when it runs, on the ledger directly
// when it does not, never beside a daemon that is alive but silent; purge asks first. Temp homes, loopback.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '@do-it-all-claude-code/core';
import { dataExport, dataPurge, realDataDeps, type DataDeps } from '../src/data.ts';
import { testPort } from './ports.ts';

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-data-'));
  process.env.DO_IT_ALL_CLAUDE_CODE_HOME = path.join(tmp, 'home');
});

interface Fake { deps: DataDeps; lines: string[]; posts: unknown[]; stdout: string[] }
function fake(o: { result?: Record<string, unknown>; stuck?: boolean; tty?: boolean; answer?: boolean; exportBody?: string } = {}): Fake {
  const f: Fake = { lines: [], posts: [], stdout: [], deps: undefined as unknown as DataDeps };
  const result = { dryRun: true, requests: 2, keptOpen: 1, rows: { requests: 2, events: 9 }, compacted: false, ...o.result };
  f.deps = {
    daemon: async () => (o.stuck ? null : {
      get: async () => ({ status: 200, body: o.exportBody ?? '{"type":"export"}\n{"type":"request"}\n' }),
      post: async (_p, body) => { f.posts.push(body); return { status: 200, body: JSON.stringify({ ...result, dryRun: (body as { dryRun: boolean }).dryRun }) }; },
    }),
    daemonStuck: () => o.stuck === true,
    openLedger: async () => { throw new Error('not in this test'); },
    out: l => { f.lines.push(l); }, err: l => { f.lines.push(`[err] ${l}`); }, writeStdout: t => { f.stdout.push(t); },
    confirm: async () => o.answer ?? true, isTTY: o.tty ?? true,
  };
  return f;
}

test('purge: one of --before / --all; counts first, then asks; --yes for scripts; nothing beside a silent daemon', async () => {
  assert.equal(await dataPurge({}, fake().deps), 2);
  assert.equal(await dataPurge({ all: true, before: '2026-10-01' }, fake().deps), 2);
  assert.equal(await dataPurge({ before: 'soon' }, fake().deps), 2);
  const asked = fake();
  assert.equal(await dataPurge({ before: '2026-10-01' }, asked.deps), 0);
  assert.deepEqual(asked.posts, [{ before: '2026-10-01T00:00:00.000Z', dryRun: true }, { before: '2026-10-01T00:00:00.000Z', dryRun: false }]);
  assert.match(asked.lines[0]!, /^This removes 2 closed request\(s\) closed before 2026-10-01T00:00:00\.000Z and 11 row\(s\) in all .* 1 open or waiting request\(s\) and everything of their sessions are kept\. It cannot be undone/);
  const declined = fake({ answer: false });
  assert.equal(await dataPurge({ all: true }, declined.deps), 1);
  assert.equal(declined.posts.length, 1, 'only the dry run');
  const script = fake({ tty: false });
  assert.equal(await dataPurge({ all: true }, script.deps), 1);
  assert.match(script.lines.at(-1)!, /re-run with --yes/);
  assert.equal(await dataPurge({ all: true, yes: true }, fake({ tty: false }).deps), 0);
  const empty = fake({ result: { requests: 0, rows: {} } });
  assert.equal(await dataPurge({ all: true }, empty.deps), 0);
  assert.match(empty.lines[0]!, /^Nothing to remove\./);
  const stuck = fake({ stuck: true });
  assert.equal(await dataPurge({ all: true, yes: true }, stuck.deps), 1);
  assert.match(stuck.lines[0]!, /running but not answering/);
});

test('export: to a 0600 file or to stdout (the note on stderr); dates are checked', async () => {
  const out = path.join(tmp, 'cases.jsonl');
  const f = fake();
  assert.equal(await dataExport({ out }, f.deps), 0);
  assert.equal(fs.readFileSync(out, 'utf8'), '{"type":"export"}\n{"type":"request"}\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.match(f.lines[0]!, /^Exported 1 request\(s\) to /);
  const s = fake();
  assert.equal(await dataExport({}, s.deps), 0);
  assert.deepEqual([s.stdout.join(''), s.lines], ['{"type":"export"}\n{"type":"request"}\n', ['[err] Exported 1 request(s).']]);
  assert.equal(await dataExport({ since: 'last week' }, fake().deps), 2);
  assert.equal(await dataExport({ out: true }, fake().deps), 2);
});

test('against the real daemon, then with it stopped: export and purge reach the same ledger; an open request survives', async () => {
  const { ensureLocalState, readConfig, writeConfig } = await import('../src/setup.ts');
  const { localRequest, start, stop } = await import('../src/daemonctl.ts');
  await ensureLocalState();
  const port = await testPort();   // outside the ephemeral range, claimed (see ports.ts)
  writeConfig({ ...readConfig()!, daemonPort: port });
  const token = fs.readFileSync(paths.token(), 'utf8').trim();
  const hook = (sid: string, h: Record<string, unknown>) => localRequest(port, 'POST', '/router/v1/hooks/claude-code', {
    token, body: JSON.stringify({ session_id: sid, cwd: tmp, transcript_path: path.join(tmp, `${sid}.jsonl`), ...h }),
  });
  const lines: string[] = [];
  const d = { ...realDataDeps({ confirm: async () => true, isTTY: false }), out: (l: string) => { lines.push(l); }, err: (l: string) => { lines.push(l); } };
  const file = path.join(tmp, 'export.jsonl');
  try {
    assert.match(await start(), /^started/);
    for (const sid of ['a', 'b']) {
      assert.equal((await hook(sid, { hook_event_name: 'UserPromptSubmit', prompt: 'fix the typo in README.md', prompt_id: `p-${sid}` }))?.status, 200);
      assert.equal((await hook(sid, { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' }))?.status, 200);
    }
    assert.equal((await hook('c', { hook_event_name: 'UserPromptSubmit', prompt: 'rename the helper in src/a.ts', prompt_id: 'p-c' }))?.status, 200);
    await new Promise(r => setTimeout(r, 300));   // the records are written after the Stop hook answers
    assert.equal(await dataExport({ out: file }, d), 0);
    const exported = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { type: string });
    assert.deepEqual(exported.map(x => x.type), ['export', 'request', 'request']);
    // purge through the daemon: the two closed requests go, the open one stays
    assert.equal(await dataPurge({ all: true, yes: true }, d), 0);
    assert.match(lines.at(-1)!, /^Removed 2 closed request\(s\) \(all of them\), \d+ row\(s\) in all .*; the ledger was compacted\.$/);
    const st = JSON.parse((await localRequest(port, 'GET', '/router/v1/status?session_id=c', { token }))!.body) as { request: { id: string } | null };
    assert.ok(st.request, 'the open request is still there');
  } finally { await stop(); }
  // no daemon: the CLI opens the ledger itself
  lines.length = 0;
  assert.equal(await dataExport({ out: file }, d), 0);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, 'just the header now');
  assert.equal(await dataPurge({ all: true, yes: true }, d), 0);
  // with no daemon only its logs are left to empty (decision 142), and its endpoint file and socket go (decision 156);
  // the open request and its session stay
  assert.match(lines.at(-1)!, /^Removed 0 closed request\(s\) \(all of them\)(, the stopped daemon's endpoint file and socket \(\d\))? and \d+ log file\(s\) emptied\.$/);
  assert.ok(!fs.existsSync(path.join(process.env.DO_IT_ALL_CLAUDE_CODE_HOME!, 'endpoint.json')), 'the endpoint file is gone');
  assert.match(lines.at(-2)!, /1 open or waiting request\(s\) and everything of their sessions are kept/);
});
