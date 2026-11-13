// The supervisor (spec 5.4, decision 130): restarts with backoff, degraded after three failures, ordered
// graceful stop; and start / stop of the real daemon through it (loopback only, temp home).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isFree } from '../src/setup.ts';
import { Supervisor, readSuperviseStatus, superviseFiles, type ChildSpec } from '../src/supervise.ts';
import { testPort } from './ports.ts';

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-sup-'));
  process.env.AGENTIC_ROUTER_HOME = path.join(tmp, 'home');
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const nodeChild = (name: string, code: string, extra: Partial<ChildSpec> = {}): ChildSpec => ({
  name, command: process.execPath, args: ['-e', code], env: process.env, stopTimeoutMs: 2000,
  stop: async child => { if (child.connected) child.send({ type: 'stop' }); }, ...extra,
});

test('a child that keeps failing is restarted with backoff and marked degraded after three failures', async () => {
  const status = path.join(tmp, 'status.json');
  const sup = new Supervisor({ specs: [nodeChild('flaky', 'process.exit(3)')], statusFile: status, backoffMs: [20, 40, 60, 80], degradedAfter: 3 });
  sup.start();
  try {
    // each restart is a node cold start: under a full parallel suite that alone can take a second or more, so the
    // wait is a deadline that ends as soon as the third restart is in, not a fixed count of short polls
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && sup.states().flaky!.restarts < 3) await sleep(20);
    const s = sup.states().flaky!;
    assert.ok(s.restarts >= 3);
    assert.equal(s.state, 'degraded');
    assert.equal(s.lastExit?.code, 3);
    const file = JSON.parse(fs.readFileSync(status, 'utf8'));
    assert.equal(file.pid, process.pid);
    assert.equal(file.children.flaky.state, 'degraded');
  } finally { await sup.stop(); }
  assert.equal(sup.states().flaky!.state, 'stopped');
});

test('stop asks the children in reverse order (the proxy before the daemon), and kills one that does not go', async () => {
  const order: string[] = [];
  const listen = "process.on('message', m => { if (m && m.type === 'stop') process.exit(0); }); setInterval(() => {}, 1000);";
  const sup = new Supervisor({
    specs: [
      nodeChild('daemon', listen, { stop: async c => { order.push('daemon'); c.send({ type: 'stop' }); } }),
      nodeChild('proxy', listen, { stop: async c => { order.push('proxy'); c.send({ type: 'stop' }); } }),
      nodeChild('stuck', 'setInterval(() => {}, 1000)', { stopTimeoutMs: 300, stop: async () => { order.push('stuck'); } }),
    ],
    statusFile: path.join(tmp, 's.json'),
  });
  sup.start();
  await sleep(500);
  assert.deepEqual(Object.values(sup.states()).map(s => s.state), ['running', 'running', 'running']);
  const pids = Object.values(sup.states()).map(s => s.pid!);
  const t0 = Date.now();
  await sup.stop();
  assert.deepEqual(order, ['stuck', 'proxy', 'daemon']);
  // bounded: two graceful waits (2 s each), the stuck one killed after 0.3 s plus its exit wait; well under this even under load
  assert.ok(Date.now() - t0 < 20_000);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), 'child is gone');
  assert.deepEqual(Object.values(sup.states()).map(s => s.state), ['stopped', 'stopped', 'stopped']);
});

/** An OS-assigned free port: test files run in parallel, and two temp homes must not pick the same one. */
async function ownPort(): Promise<void> {
  const { readConfig, writeConfig } = await import('../src/setup.ts');
  const port = await testPort();   // outside the ephemeral range, claimed (see ports.ts)
  writeConfig({ ...readConfig()!, daemonPort: port });
}

test('a mode switch: reconcile stops the child no longer wanted (no restart) and starts a new one, leaving the rest running', async () => {
  const listen = "process.on('message', m => { if (m && m.type === 'stop') process.exit(0); }); setInterval(() => {}, 1000);";
  const daemon = nodeChild('daemon', listen), proxy = nodeChild('proxy', listen);
  const sup = new Supervisor({ specs: [daemon, proxy], statusFile: path.join(tmp, 's.json'), backoffMs: [20] });
  sup.start();
  try {
    await sleep(400);
    const daemonPid = sup.states().daemon!.pid;
    const proxyPid = sup.states().proxy!.pid!;
    assert.deepEqual(await sup.reconcile([daemon]), { stopped: ['proxy'], started: [] });
    assert.deepEqual(Object.keys(sup.states()), ['daemon']);
    assert.throws(() => process.kill(proxyPid, 0), 'the proxy is gone');
    await sleep(200);
    assert.deepEqual(Object.keys(sup.states()), ['daemon'], 'and not restarted');
    assert.equal(sup.states().daemon!.pid, daemonPid, 'the daemon kept running');
    assert.deepEqual(await sup.reconcile([daemon, nodeChild('proxy', listen)]), { stopped: [], started: ['proxy'] });
    await sleep(300);
    assert.equal(sup.states().proxy!.state, 'running');
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 's.json'), 'utf8')).children.proxy.state, 'running');
  } finally { await sup.stop(); }
});

test('start and stop run the real daemon under the supervisor', async () => {
  const { ensureLocalState, readConfig } = await import('../src/setup.ts');
  const { start, status, stop, runningSupervisor } = await import('../src/daemonctl.ts');
  await ensureLocalState();
  await ownPort();
  const cfg = readConfig()!;
  try {
    const started = await start();
    assert.match(started, /^started \(supervisor pid \d+; daemon on 127\.0\.0\.1:\d+\)$/, started);
    assert.ok(runningSupervisor());
    assert.match(await start(), /already running \(supervisor pid/);
    const st = await status();
    assert.match(st, /Router ON/);
    assert.match(st, /supervisor pid \d+: daemon running/);
    assert.equal(readSuperviseStatus()?.children.daemon?.state, 'running');
    const stopped = await stop();
    assert.equal(stopped, 'stopped (supervisor, proxy and daemon)');
    assert.equal(runningSupervisor(), undefined);
    assert.ok(await isFree(cfg.daemonPort), 'the daemon port is free again');
    assert.ok(!fs.existsSync(superviseFiles().pid));
  } finally {
    if ((await import('../src/daemonctl.ts')).runningSupervisor()) await stop();
  }
});

test('decision 157: reconcile restarts a child whose key changed (the proxy turning local TLS on or off), and leaves an unchanged one running', async () => {
  const listen = "process.on('message', m => { if (m && m.type === 'stop') process.exit(0); }); setInterval(() => {}, 1000);";
  const daemon = nodeChild('daemon', listen);
  const sup = new Supervisor({ specs: [daemon, nodeChild('proxy', listen, { key: 'tls=false' })], statusFile: path.join(tmp, 'k.json'), backoffMs: [20] });
  sup.start();
  try {
    await sleep(400);
    const before = { daemon: sup.states().daemon!.pid, proxy: sup.states().proxy!.pid! };
    assert.deepEqual(await sup.reconcile([daemon, nodeChild('proxy', listen, { key: 'tls=false' })]), { stopped: [], started: [] }, 'same key: nothing');
    assert.deepEqual(await sup.reconcile([daemon, nodeChild('proxy', listen, { key: 'tls=true' })]), { stopped: ['proxy'], started: ['proxy'] });
    await sleep(400);
    assert.throws(() => process.kill(before.proxy, 0), 'the old proxy is gone');
    assert.notEqual(sup.states().proxy!.pid, before.proxy);
    assert.equal(sup.states().proxy!.state, 'running');
    assert.equal(sup.states().daemon!.pid, before.daemon, 'the daemon kept running');
  } finally { await sup.stop(); }
});
