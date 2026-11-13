// Decision 164: the daemon's Bearer route is off by default. The switch (config bearerApi "on") stays for this
// release; doctor warns while it is on. The router's own clients never send the token: the CLI's daemon calls are
// sealed, and the plain request it still makes carries no credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import { bearerApiCheck } from '../src/doctor.ts';
import { daemonRequest, localRequest } from '../src/daemonctl.ts';
import type { CliConfig } from '../src/setup.ts';

const cfg = (o: Partial<CliConfig>): CliConfig => ({ daemonPort: 47800, fableOptIn: false, budgetsUsd: { L0: 1, L1: 1, L2: 1, L3: 1 }, ...o });

test('decision 164: doctor warns while bearerApi is on, and says nothing otherwise', () => {
  assert.equal(bearerApiCheck(cfg({})), null);
  assert.equal(bearerApiCheck(cfg({ bearerApi: 'off' })), null);
  const on = bearerApiCheck(cfg({ bearerApi: 'on' }))!;
  assert.deepEqual([on.name, on.ok, on.blocking], ['bearerApi', false, false]);
  assert.match(on.detail, /deprecated and will be removed/);
});

test('decision 164: the CLI sends the daemon no Authorization header, sealed or not', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  const s = http.createServer((req, res) => { seen.push(req.headers); req.resume(); res.writeHead(401); res.end(); });
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  try {
    await localRequest(port, 'GET', '/router/v1/health');
    assert.equal(await daemonRequest(port, 'GET', '/router/v1/status', { token: 'a-local-token-0123456789abcdef' }), null, 'not the daemon: no answer');
    assert.equal(seen.length, 2);
    for (const h of seen) assert.equal(h.authorization, undefined);
    assert.ok(!JSON.stringify(seen).includes('a-local-token-0123456789abcdef'), 'the token is never sent');
  } finally { await new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }); }
});
