import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '@agentic-router/core';

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
