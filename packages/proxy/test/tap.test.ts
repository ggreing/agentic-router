import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { UsageTap } from '../src/tap.ts';
import { event, messageStream } from './helpers.ts';

const SSE = 'text/event-stream';
const run = async (chunks: Array<string | Buffer>, type = SSE, enc?: string) => {
  const t = new UsageTap(type, enc);
  for (const c of chunks) t.write(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return t.end();
};

test('usage from a stream split at every byte boundary', async () => {
  const s = messageStream({ id: 'msg_split', input: 11, output: 22, cacheRead: 33, cacheWrite: 44 }).join('');
  const whole = await run([s]);
  assert.deepEqual(whole, { sawStart: true, sawStop: true, messageId: 'msg_split', model: 'claude-haiku-5-5',
    usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 } });
  for (let i = 1; i < s.length; i += 7) assert.deepEqual(await run([s.slice(0, i), s.slice(i)]), whole, `split at ${i}`);
  const bytes = Buffer.from(s);
  assert.deepEqual(await run([...bytes].map(b => Buffer.from([b]))), whole);   // one byte at a time (UTF-8 safe)
});

test('CRLF line endings, comments, a cumulative delta that restates input, cache-creation detail', async () => {
  const s = [
    ': keep-alive comment',
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":5,"output_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":7}}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":9}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":15,"input_tokens":6,"cache_creation":{"ephemeral_1h_input_tokens":3}}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '', '',
  ].join('\r\n');
  const r = await run([s]);
  assert.deepEqual(r.usage, { input_tokens: 6, output_tokens: 15, cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 3 } });
  assert.equal(r.sawStop, true);
});

test('a 2 MB content delta is skipped without being held; an error event is noted', async () => {
  const ev = messageStream({ id: 'big', text: 'z'.repeat(2 * 1024 * 1024) });
  const r = await run(ev);
  assert.deepEqual([r.messageId, r.usage?.output_tokens, r.sawStop], ['big', 20, true]);
  const e = await run([ev[0]!, event('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })]);
  assert.deepEqual([e.sawStart, e.sawStop, e.errorType], [true, false, 'overloaded_error']);
});

test('compressed copies (gzip, deflate, br) and non-stream JSON bodies', async () => {
  const s = messageStream({ id: 'gz', input: 3 }).join('');
  for (const [enc, z] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync]] as const) {
    const b = z(Buffer.from(s));
    const r = await run([b.subarray(0, 10), b.subarray(10)], SSE, enc);
    assert.deepEqual([r.messageId, r.usage?.input_tokens], ['gz', 3], enc);
  }
  const json = await run([JSON.stringify({ id: 'msg_j', type: 'message', model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 2 } })], 'application/json');
  assert.deepEqual([json.messageId, json.model, json.usage, json.sawStop], ['msg_j', 'claude-sonnet-5-5', { input_tokens: 1, output_tokens: 2 }, true]);
  const err = await run(['{"type":"error","error":{"type":"invalid_request_error","message":"x"}}'], 'application/json');
  assert.equal(err.errorType, 'invalid_request_error');
  const broken = await run([Buffer.from('not gzip at all')], SSE, 'gzip');          // a broken copy loses usage only
  assert.equal(broken.sawStart, false);
  const junk = await run(['{"usage":{"input_tokens":-5,"output_tokens":"x"}}'], 'application/json');
  assert.equal(junk.usage, undefined);
});
