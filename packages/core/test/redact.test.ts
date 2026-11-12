import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactJson } from '@agentic-router/core';

// The 17 shapes from the pre-release audit (A5). Each entry: a line, and the secret substring that must
// NOT survive redaction. The first seven already masked before A5; the last ten were the misses.
const CASES: Array<[string, string]> = [
  ['key = sk-ant-api03-ABCDEFGHIJ12345678', 'ABCDEFGHIJ12345678'],
  ['run with --password=hunter2secretpw', 'hunter2secretpw'],
  ['clone https://alice:s3cretPassw0rd@example.com/x.git', 's3cretPassw0rd'],
  ['config {"api_key": "VALUEaaaaaaaa1234"}', 'VALUEaaaaaaaa1234'],
  ['API_KEY="VALUEbbbbbbbb1234"', 'VALUEbbbbbbbb1234'],
  ['Authorization: Bearer abcdefghijkl1234567890', 'abcdefghijkl1234567890'],
  ['token ghp_ABCDEFGHIJ1234567890abcdWXYZ', 'ghp_ABCDEFGHIJ1234567890abcdWXYZ'],
  ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcd1234ABCD', 'wJalrXUtnFEMIabcd1234ABCD'],
  ['SLACK_TOKEN=xoxb-111-222-abcdefabcdef', 'xoxb-111-222-abcdefabcdef'],
  ['NPM_TOKEN=npm_ABCDEFGHIJ1234567890abcd', 'npm_ABCDEFGHIJ1234567890abcd'],
  ['-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAKj34GkxFhD\nabcdef==\n-----END RSA PRIVATE KEY-----', 'MIIBOwIBAAJBAKj34GkxFhD'],
  ['openai sk-proj-ABCDEFGHIJ1234567890', 'sk-proj-ABCDEFGHIJ1234567890'],
  ['stripe sk_live_ABCDEFGHIJ1234567890', 'sk_live_ABCDEFGHIJ1234567890'],
  ['Cookie: session=abc123def456ghi; theme=dark', 'abc123def456ghi'],
  ['{"name":"api_key","value":"SHORTV"}', 'SHORTV'],
  ['API_KEY=short', 'short'],                                        // value under 8 chars
  ['api_key=FIRSTsecret9999,SECONDsecret8888', 'SECONDsecret8888'],  // tail after a comma
];

test('redact masks all 17 audited secret shapes (A5)', () => {
  for (const [line, secret] of CASES) {
    const out = redact(line);
    assert.ok(!out.includes(secret), `secret survived redaction: ${line}\n  -> ${out}`);
  }
});

test('redact leaves non-secret text alone', () => {
  for (const ok of ['the secret of success is persistence', 'tokenize the input string', 'password reset email sent', 'key points below:']) {
    assert.equal(redact(ok), ok, `over-masked: ${ok}`);
  }
});

test('redact still honors extra literal secrets', () => {
  assert.ok(!redact('value is MYLITERALSECRET here', ['MYLITERALSECRET']).includes('MYLITERALSECRET'));
});

// N1: redact must not break a serialized JSON document, and a quoted value with spaces is masked whole.
test('redact does not corrupt serialized JSON (N1): token counts survive and it still parses', () => {
  const obj = { status: 'completed', totalTokens: 1234, usage: { input_tokens: 3, output_tokens: 4 }, totalDurationMs: 5 };
  const out = redact(JSON.stringify(obj));
  assert.doesNotThrow(() => JSON.parse(out), `redacted JSON must still parse: ${out}`);
  assert.deepEqual(JSON.parse(out), obj, 'non-secret numbers and keys are untouched');
});
test('redact masks a quoted secret value through to its closing quote (N1)', () => {
  const out = redact('DB_PASSWORD="secret horse battery"');
  assert.ok(!out.includes('horse') && !out.includes('battery'), out);
  assert.ok(out.endsWith('"'), `the closing quote is kept: ${out}`);
});
test('redact does not over-mask a non-secret key that merely contains a secret word (N1)', () => {
  assert.equal(redact('{"totalTokens":1234}'), '{"totalTokens":1234}');
  assert.equal(redact('monkey: banana'), 'monkey: banana');
  assert.equal(redact('Set primary key = id'), 'Set primary key = id');
});
test('redact masks a bare secret-word assignment in plain text (but not the common word "key")', () => {
  for (const [line, secret] of [
    ['set password=hunter2hunter2 in the config', 'hunter2hunter2'],
    ['password: hunter2hunter2', 'hunter2hunter2'],
    ['secret: "s3cr3t-value-123"', 's3cr3t-value-123'],
    ['token=abcdef0123456789', 'abcdef0123456789'],
  ] as Array<[string, string]>) {
    assert.ok(!redact(line).includes(secret), `survived: ${line} -> ${redact(line)}`);
  }
  assert.equal(redact('primary key = id'), 'primary key = id');   // "key" alone stays prose
});
test('redact is idempotent: masking an already-masked value does not double the bracket', () => {
  const once = redact('api_key=0123456789abcdef');
  assert.equal(redact(once), once, `not idempotent: ${redact(once)}`);
  assert.ok(!redact(once).includes('[REDACTED]]'));
});

// N6: masking stays linear on long unbroken input.
test('redact is linear on long unbroken input (N6): 1 MB of hex well under 500 ms', () => {
  const big = 'a1b2c3d4e5f6'.repeat(90_000);   // ~1.08 MB, no secret shapes
  const t0 = performance.now();
  const out = redact(big);
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
  assert.ok(out.length > 0);
});

// A5 remainder: a few more vendor prefixes now covered (B3).
test('redact masks additional vendor token shapes (A5 remainder)', () => {
  for (const [line, secret] of [
    ['gitlab glrt-ABCDEFGHIJ1234567890', 'glrt-ABCDEFGHIJ1234567890'],
    ['stripe rk_live_ABCDEFGHIJ1234567890', 'rk_live_ABCDEFGHIJ1234567890'],
    ['stripe whsec_ABCDEFGHIJ1234567890', 'whsec_ABCDEFGHIJ1234567890'],
    ['google AIzaSyABCDEFGHIJ1234567890abcdef', 'AIzaSyABCDEFGHIJ1234567890abcdef'],
    ['hugging hf_ABCDEFGHIJ1234567890abcd', 'hf_ABCDEFGHIJ1234567890abcd'],
    ['aws ASIAABCDEFGHIJ123456', 'ASIAABCDEFGHIJ123456'],
  ] as Array<[string, string]>) {
    assert.ok(!redact(line).includes(secret), `survived: ${line} -> ${redact(line)}`);
  }
});

// N1: redactJson walks a parsed value, masks string leaves, keeps shape and non-strings.
test('redactJson masks secret-keyed and embedded secrets, keeps numbers and shape', () => {
  const input = {
    status: 'ok', totalTokens: 1234,
    api_key: 'VALUEaaaaaaaa1234', apiKey: 'alsoSecretValue99', note: 'contains sk-ant-api03-ABCDEFGHIJ12345678 inline',
    nested: { accessToken: 'tok_abcdefghij', count: 7, flag: true, nothing: null },
    list: ['plain text', 'sk_live_ABCDEFGHIJ1234567890'],
  };
  const out = redactJson(input) as typeof input;
  const text = JSON.stringify(out);
  assert.doesNotThrow(() => JSON.parse(text));
  for (const s of ['VALUEaaaaaaaa1234', 'alsoSecretValue99', 'ABCDEFGHIJ12345678', 'tok_abcdefghij', 'sk_live_ABCDEFGHIJ1234567890']) {
    assert.ok(!text.includes(s), `secret survived redactJson: ${s}`);
  }
  assert.equal(out.totalTokens, 1234);
  assert.equal(out.nested.count, 7);
  assert.equal(out.nested.flag, true);
  assert.equal(out.nested.nothing, null);
  assert.equal(out.status, 'ok');
  assert.equal(out.list[0], 'plain text');
});
