// Sealed messages (decision 156): the envelope, what is refused, known answers, and that the plugin's
// dependency-free copy (plugin/hooks/seal.mjs) is the same thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NonceWindow, SEALED_PATH, SEAL_WINDOW_MS, SealError, openRequest, openResponse, sealRequest, sealResponse } from '@do-it-all-claude-code/core';
import * as plugin from '../../../plugin/hooks/seal.mjs';

const SECRET = 'test-token-0123456789abcdef0123456789abcdef';
const NONCE = Buffer.from('000102030405060708090a0b', 'hex');
const NOW = 1_800_000_000_000;
const REQ = { m: 'POST', p: '/router/v1/hooks/claude-code', b: '{"hook_event_name":"UserPromptSubmit","prompt":"hi"}' };
const code = (f: () => unknown): string => { try { f(); return 'accepted'; } catch (e) { return e instanceof SealError || e instanceof plugin.SealError ? (e as SealError).code : `threw ${String(e)}`; } };

test('a request and its answer round-trip; the secret and the content are not in the envelope', () => {
  const { envelope, nonce } = sealRequest(SECRET, REQ);
  assert.ok(!envelope.includes(SECRET) && !envelope.includes('UserPromptSubmit') && !envelope.includes('/router/v1/hooks'));
  assert.deepEqual(Object.keys(JSON.parse(envelope)).sort(), ['c', 'n', 't', 'v']);
  const got = openRequest(SECRET, envelope);
  assert.deepEqual([got.inner, got.nonce], [REQ, nonce]);
  const answer = sealResponse(SECRET, nonce, { s: 200, ct: 'application/json', b: '{"ok":true}' });
  assert.ok(!answer.includes('"ok"'));
  assert.deepEqual(openResponse(SECRET, nonce, answer), { s: 200, ct: 'application/json', b: '{"ok":true}' });
  // two seals of the same request differ (fresh nonce each time)
  assert.notEqual(sealRequest(SECRET, REQ).envelope, envelope);
});

test('known answers: fixed secret, nonce and time give these exact bytes, from core and from the plugin copy', () => {
  const clock = { now: NOW, nonce: NONCE };
  const a = sealRequest(SECRET, REQ, clock);
  const b = plugin.sealRequest(SECRET, REQ, clock);
  assert.equal(a.envelope, b.envelope, 'core and plugin seal identically');
  assert.equal(a.nonce, 'AAECAwQFBgcICQoL');
  const e = JSON.parse(a.envelope);
  assert.deepEqual([e.v, e.n, e.t], [1, 'AAECAwQFBgcICQoL', NOW]);
  // the ciphertext is pinned: a change to the key derivation, the associated data or the cipher shows here
  assert.equal(e.c, KNOWN_REQUEST_C);
  const res = sealResponse(SECRET, a.nonce, { s: 200, ct: 'application/json', b: '{}' }, { now: NOW + 5, nonce: Buffer.from('0b0a09080706050403020100', 'hex') });
  assert.equal(JSON.parse(res).c, KNOWN_RESPONSE_C);
  assert.deepEqual(plugin.openResponse(SECRET, a.nonce, res), { s: 200, ct: 'application/json', b: '{}' });
  assert.deepEqual(openResponse(SECRET, a.nonce, res), { s: 200, ct: 'application/json', b: '{}' });
  assert.equal(plugin.SEALED_PATH, SEALED_PATH);
  assert.equal(plugin.SEAL_VERSION, 1);
});
// computed with node:crypto directly (HKDF-SHA256, AES-256-GCM), not with the module under test
const KNOWN_REQUEST_C = 'Obm1m4LVm7VAkqcqtcb2pAGVs0KplL_EY7uQHgXZSgRqFILO_jR4o0zKpgxOgIrgoSpEDFWZaAIBJwyPpDlddiifN4q9HVxvW9oD46uKMvwZaPA131jmH88FzIW-JZey_VN7mSYLsIsXKXnD3PEvGTY47G9rU1ZR1rvbaPy9U7Brtg';
const KNOWN_RESPONSE_C = 'ds1q-o6qkSdFjCJtmi9RjqLL4HQHG3ni0AbnLY-gai37nJWaL7UcVc6zY0OSHlP4tTpZK8RoK_9p7Q';

test('the construction is what the header says: HKDF-SHA256 per direction, AES-256-GCM, version, direction, time and nonce bound in', async () => {
  const { createDecipheriv, hkdfSync } = await import('node:crypto');
  const e = JSON.parse(sealRequest(SECRET, REQ, { now: NOW, nonce: NONCE }).envelope);
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET), 'agentic-router seal v1', 'req', 32));
  const raw = Buffer.from(e.c, 'base64url');
  const d = createDecipheriv('aes-256-gcm', key, NONCE);
  d.setAAD(Buffer.from(`v1|req|${NOW}|${e.n}`));
  d.setAuthTag(raw.subarray(raw.length - 16));
  assert.deepEqual(JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8')), REQ);
});

test('what is refused, and that every refusal is a SealError', () => {
  const { envelope, nonce } = sealRequest(SECRET, REQ, { now: NOW });
  const e = JSON.parse(envelope);
  const open = (text: string, opts: object = {}) => code(() => openRequest(SECRET, text, { now: NOW, ...opts }));
  assert.equal(open(envelope), 'accepted');
  assert.equal(code(() => openRequest('another-secret', envelope, { now: NOW })), 'auth');
  // any change to the envelope
  const flip = (s: string) => s.slice(0, 5) + (s[5] === 'A' ? 'B' : 'A') + s.slice(6);
  assert.equal(open(JSON.stringify({ ...e, c: flip(e.c) })), 'auth');
  assert.equal(open(JSON.stringify({ ...e, n: flip(e.n) })), 'auth');
  assert.equal(open(JSON.stringify({ ...e, t: e.t + 1 })), 'auth', 'the time is bound in');
  assert.equal(open(JSON.stringify({ ...e, c: e.c.slice(0, -4) })), 'auth');
  assert.equal(open(JSON.stringify({ ...e, v: 2 })), 'version');
  for (const bad of ['', 'not json', '[]', 'null', '{}', JSON.stringify({ ...e, n: 'short' }), JSON.stringify({ ...e, c: 'has spaces' }), JSON.stringify({ ...e, t: 'now' }), JSON.stringify({ ...e, c: 'AAAA' })])
    assert.equal(open(bad), 'format', bad.slice(0, 30));
  // time window and replay
  assert.equal(open(envelope, { now: NOW + SEAL_WINDOW_MS + 1 }), 'stale');
  assert.equal(open(envelope, { now: NOW - SEAL_WINDOW_MS - 1 }), 'stale');
  assert.equal(open(envelope, { now: NOW + SEAL_WINDOW_MS }), 'accepted');
  const seen = new NonceWindow();
  assert.equal(open(envelope, { seen }), 'accepted');
  assert.equal(open(envelope, { seen }), 'replay');
  assert.equal(open(sealRequest(SECRET, REQ, { now: NOW }).envelope, { seen }), 'accepted', 'another request is fine');
  // a message that does not authenticate does not use up a nonce or reveal the window
  const forged = JSON.stringify({ ...e, n: 'BBBBBBBBBBBBBBBB' });
  assert.equal(open(forged, { seen, now: NOW + 10 * SEAL_WINDOW_MS }), 'auth');
  assert.equal(seen.size, 2);
  // the inner request must be a request
  for (const inner of [{ p: '/x' }, { m: 'GET' }, { m: 'GET', p: 'x' }, { m: 'GET', p: '/x', b: 1 }, [] as unknown, 'x' as unknown])
    assert.equal(open(sealRequest(SECRET, inner as never, { now: NOW }).envelope), 'format');

  // answers: bound to the request's nonce and to the response direction
  const answer = sealResponse(SECRET, nonce, { s: 200, ct: 'text/plain', b: 'ok' });
  for (const openRes of [openResponse, plugin.openResponse]) {
    assert.equal(code(() => openRes(SECRET, nonce, answer)), 'accepted');
    assert.equal(code(() => openRes(SECRET, 'CCCCCCCCCCCCCCCC', answer)), 'auth', 'an answer to another request');
    assert.equal(code(() => openRes('another-secret', nonce, answer)), 'auth');
    assert.equal(code(() => openRes(SECRET, nonce, envelope)), 'auth', 'a request played back as its own answer');
    assert.equal(code(() => openRes(SECRET, nonce, '{"ok":true}')), 'format', 'a plain answer');
    assert.equal(code(() => openRes(SECRET, nonce, JSON.stringify({ ...JSON.parse(answer), v: 9 }))), 'version');
  }
  assert.equal(code(() => openRequest(SECRET, answer, { now: NOW })), 'auth', 'an answer played back as a request');
});

test('the nonce window forgets after its time and refuses rather than forgets when it is full', () => {
  const w = new NonceWindow(1000, 4);
  assert.deepEqual([w.take('a', 0), w.take('a', 10), w.take('b', 10)], [true, false, true]);
  assert.equal(w.take('a', 2001), true, 'after twice the window the nonce may come again (its time would be stale anyway)');
  assert.deepEqual([w.take('c', 2002), w.take('d', 2003)], [true, true]);
  assert.ok(w.size <= 4);
  const full = new NonceWindow(1000, 2);
  assert.deepEqual([full.take('a', 0), full.take('b', 0), full.take('c', 0)], [true, true, false]);
});
