// Auto-release in the CLI (decision 138): the init/doctor wording, `routing reset`, and the doctor lines read
// from the real daemon's status (temp home, loopback; a released level is seeded in its ledger first).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '@agentic-router/core';
import type { StatusView } from '@agentic-router/daemon';
import { autoReleaseSummary, configuredAutoRelease, routingChecks, routingReset } from '../src/routing.ts';
import { testPort } from './ports.ts';

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-routing-'));
  process.env.AGENTIC_ROUTER_HOME = path.join(tmp, 'home');
});
type Routing = StatusView['routing'];

test('the holdout is spelled out: mode, share, how to stop it; the file reader\'s default is 10%', () => {
  assert.equal(autoReleaseSummary('observe', 0.1),
    'observe: the comparison is kept and shown, nothing is switched; holdout 10% (about 1 in 10 requests at a delegated level is handled directly on purpose, as the baseline; set holdoutRate 0 or autoRelease "off" in config.json to stop)');
  assert.match(autoReleaseSummary('on', 0.2), /^on: a delegated level whose subagents cost more .*routing reset undoes it\); holdout 20% \(about 1 in 5 /);
  assert.match(autoReleaseSummary('observe', 0), /holdout off/);
  assert.equal(autoReleaseSummary('off', 0), 'off: delegated levels stay as configured and no request is held out');
  assert.deepEqual(configuredAutoRelease({}), { mode: 'observe', rate: 0.1 });
  assert.deepEqual(configuredAutoRelease({ holdoutRate: 0.5 }), { mode: 'observe', rate: 0.2 });
  assert.deepEqual(configuredAutoRelease({ autoRelease: 'off', holdoutRate: 0.2 }), { mode: 'off', rate: 0 });
});

test('doctor lines: released levels with the undo, and in observe mode what would be released', () => {
  const arm = { n: 0, accepted: 0, costUsd: 0, costPerAcceptedUsd: null };
  const level = (o: Record<string, unknown>) => ({
    level: 'L1', delegatedByConfig: true, released: false, candidate: false, delegated: arm, direct: arm,
    decision: { action: 'hold', reason: 'not_enough_data', ratio: null, delegatedCost: null, directCost: null, need: { delegated: [0, 20], direct: [0, 8] } }, ...o,
  });
  const view = (mode: Routing['mode']) => ({
    mode, holdoutRate: 0.1, rule: {},
    classes: [
      { leadClass: 'opus', configuredFrom: 'L1', autoFrom: 'L2', effectiveFrom: 'L2', levels: [level({ released: true }), level({ level: 'L2', candidate: true })] },
      { leadClass: 'sonnet', configuredFrom: 'L1', autoFrom: null, effectiveFrom: 'L1', levels: [
        level({ candidate: true, decision: { action: 'release', reason: 'delegated_dearer', ratio: 1.6, delegatedCost: 0.48, directCost: 0.3, need: { delegated: [20, 20], direct: [8, 8] } } }),
      ] },
    ],
  }) as unknown as Routing;
  assert.deepEqual(routingChecks(view('observe')).map(c => [c.name, c.detail.replace(/;.*$/, '')]), [
    ['auto-release', 'observe: the comparison is kept and shown, nothing is switched'],
    ['routing: opus lead', 'L1 requests are handled directly (released'],
    ['routing: sonnet lead', 'L1 would be released (delegated $0.4800 vs direct $0.3000 per accepted task)'],
  ]);
  assert.ok(routingChecks(view('observe')).every(c => c.ok && !c.blocking));
  assert.equal(routingChecks(view('on')).filter(c => /would be released/.test(c.detail)).length, 0, 'mode on releases instead of saying so');
  assert.deepEqual(routingChecks(undefined), []);
});

test('routing reset: what the daemon cleared, or why nothing happened', async () => {
  const run = async (answer: { status: number; body: string } | null) => {
    const lines: string[] = [];
    const code = await routingReset({ port: 1, token: 't', post: async () => answer, out: l => { lines.push(l); } });
    return [code, lines.join('\n')] as const;
  };
  assert.deepEqual(await run({ status: 200, body: '{"cleared":2}' }), [0, 'Cleared the auto-release state of 2 lead model class(es): every level is delegated as configured again. The request records are kept.']);
  assert.deepEqual(await run({ status: 200, body: '{"cleared":0}' }), [0, 'Nothing was released.']);
  assert.match((await run(null))[1], /not running/);
  assert.match((await run({ status: 404, body: '{}' }))[1], /no auto-release/);
  assert.deepEqual((await run({ status: 500, body: 'x' }))[0], 1);
});

test('against the real daemon: a released level shows in doctor\'s lines, and routing reset delegates it again', async () => {
  const { ensureLocalState, readConfig, writeConfig } = await import('../src/setup.ts');
  const { localRequest, start, stop } = await import('../src/daemonctl.ts');
  const { Ledger } = await import('@agentic-router/daemon');
  await ensureLocalState();
  const port = await testPort();   // outside the ephemeral range, claimed (see ports.ts)
  writeConfig({ ...readConfig()!, daemonPort: port, autoRelease: 'on' });
  const l = new Ledger(paths.db());
  l.setRelease('opus', { autoDelegateFrom: 'L2' }, new Date().toISOString());
  l.close();
  const token = fs.readFileSync(paths.token(), 'utf8').trim();
  const routing = async () => (JSON.parse((await localRequest(port, 'GET', '/router/v1/status', { token }))!.body) as StatusView).routing;
  try {
    assert.match(await start(), /^started/);
    const before = routingChecks(await routing());
    assert.match(before[0]!.detail, /^on: .*holdout 10%/, 'no holdoutRate in config.json: the reader\'s 0.1');
    assert.deepEqual(before.filter(c => c.name === 'routing: opus lead').map(c => c.detail), ['L1 requests are handled directly (released; undo: agentic-router routing reset)']);
    const lines: string[] = [];
    assert.equal(await routingReset({ port, token, out: x => { lines.push(x); } }), 0);
    assert.match(lines[0]!, /^Cleared the auto-release state of 1 lead model class/);
    assert.deepEqual(routingChecks(await routing()).filter(c => c.name.startsWith('routing:')), []);
  } finally { await stop(); }
});
