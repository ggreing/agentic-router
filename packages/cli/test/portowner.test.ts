// Who listens on a port (decision 156, option c): a hint for messages. The parsers are tested on sample
// output of each system's tool; the live lookup is tried on the system the test runs on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parseLsof, parseNetstat, parseProcNetTcp, parseTasklistUser, portOwner, portOwnerInfo } from '../src/portowner.ts';

test('Linux: /proc/net/tcp gives the uid of the listener', () => {
  const text = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:BAB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 12345 1 0000000000000000 100 0 0 10 0',
    '   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222 1 0000000000000000 100 0 0 10 0',
    '   2: 0100007F:BAB8 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0000000000000000 20 4 30 10 -1',
  ].join('\n');
  assert.deepEqual(parseProcNetTcp(text, 0xBAB8), { uid: 1001 }, 'the listening socket (state 0A), not an established one on the same port');
  assert.deepEqual(parseProcNetTcp(text, 22), { uid: 0 });
  assert.equal(parseProcNetTcp(text, 9999), undefined);
  assert.equal(parseProcNetTcp('', 22), undefined);
});

test('Windows: netstat gives the pid, tasklist the user', () => {
  const netstat = [
    '', 'Active Connections', '', '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1180',
    '  TCP    127.0.0.1:47800        0.0.0.0:0              LISTENING       51234',
    '  TCP    127.0.0.1:47800        127.0.0.1:60111        ESTABLISHED     51234',
    '  TCP    127.0.0.1:478000       0.0.0.0:0              LISTENING       7',
  ].join('\r\n');
  assert.equal(parseNetstat(netstat, 47800), 51234);
  assert.equal(parseNetstat(netstat, 135), 1180);
  assert.equal(parseNetstat(netstat, 4780), undefined, 'a port is matched whole');
  const csv = '"Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"\r\n"node.exe","51234","Console","1","61,000 K","Unknown","DESKTOP\\other","0:00:01","N/A"\r\n';
  assert.equal(parseTasklistUser(csv), 'DESKTOP\\other');
  assert.equal(parseTasklistUser('"Image Name","PID"\r\n"node.exe","1","Services","0","1 K","Unknown","N/A","0:00:00","N/A"\r\n'), undefined);
  assert.equal(parseTasklistUser('INFO: No tasks are running which match the specified criteria.\r\n'), undefined);
});

test('macOS: lsof gives the pid and the user', () => {
  const text = 'COMMAND   PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\nnode    51234 other   23u  IPv4 0x1234567890abcdef      0t0  TCP 127.0.0.1:47800 (LISTEN)\n';
  assert.deepEqual(parseLsof(text), { pid: 51234, user: 'other' });
  assert.equal(parseLsof(''), undefined);
});

test('the live lookup: this process\'s own listener is reported as the user\'s own, or not at all; never as another user\'s', async () => {
  const s = net.createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  try {
    const port = (s.address() as net.AddressInfo).port;
    const info = await portOwnerInfo(port);
    if (info) {
      assert.notEqual(info.mine, false, JSON.stringify(info));
      if (info.pid !== undefined) assert.equal(info.pid, process.pid);
    }
    const phrase = await portOwner(port);
    assert.ok(phrase === '' || /your own process|a process/.test(phrase), phrase);
    assert.ok(!/ANOTHER/.test(phrase));
  } finally { await new Promise<void>(r => s.close(() => r())); }
});

test('sameWindowsUser: the domain counts, not only the name', async () => {
  const { sameWindowsUser } = await import('../src/portowner.ts');
  assert.equal(sameWindowsUser('DESKTOP\\Alice', 'alice', 'desktop'), true);
  assert.equal(sameWindowsUser('CORP\\alice', 'alice', 'DESKTOP'), false, 'the same name in another domain is someone else');
  assert.equal(sameWindowsUser('CORP\\alice', 'alice', undefined), false, 'own domain unknown: not taken as ours');
  assert.equal(sameWindowsUser('alice', 'alice', 'DESKTOP'), true);
  assert.equal(sameWindowsUser('DESKTOP\\bob', 'alice', 'DESKTOP'), false);
});
