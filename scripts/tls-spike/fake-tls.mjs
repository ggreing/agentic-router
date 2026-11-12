// Minimal HTTPS "Messages API" for the local-TLS spike (see run.mjs). It plays the model just enough for
// one turn: any POST /v1/messages gets a trivial end_turn text reply. It binds 127.0.0.1 only and accepts
// the dummy key of key-helper.mjs only; no request leaves the machine and no credential value is kept.
//
// The point of the spike is only whether the TLS handshake succeeds, so the body is barely read. Two things
// are recorded: `entries`, one per HTTP request that completed the handshake and was parsed (its presence is
// proof TLS worked), and `tlsErrors`, one per failed handshake or non-TLS bytes on the port — the latter is
// how a silent plain-HTTP downgrade would show up ("wrong version number" / an HTTP verb as the first bytes).
import https from 'node:https';

export const DUMMY_KEY = 'tls-spike-dummy';
const MARKER = 'TLS_SPIKE_OK';
const usage = { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const apiError = (type, message) => ({ type: 'error', error: { type, message } });
function reply(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'request-id': `req_tls_${Date.now()}` });
  res.end(text);
}
const message = model => ({ id: `msg_tls_${Date.now()}`, type: 'message', role: 'assistant', model: model || 'claude-sonnet-5-5',
  content: [{ type: 'text', text: MARKER }], stop_reason: 'end_turn', stop_sequence: null, usage });
function sse(res, model) {
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_tls_${Date.now()}` });
  ev('message_start', { message: { ...message(model), content: [], usage: { ...usage, output_tokens: 1 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: MARKER } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  ev('message_stop', {});
  res.end();
}

export async function startFakeTls({ cert, key, host = '127.0.0.1' }) {
  const entries = [];      // one per parsed HTTP request (its existence proves the TLS handshake succeeded)
  const tlsErrors = [];    // failed handshakes or non-TLS bytes (a plain-HTTP downgrade shows up here)
  const server = https.createServer({ cert, key }, (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'https://127.0.0.1');
      const keys = [req.headers['x-api-key'], req.headers.authorization].filter(v => typeof v === 'string').map(v => v.replace(/^Bearer\s+/i, '').trim());
      const credential = !keys.length ? 'none' : keys.every(k => k === DUMMY_KEY) ? 'dummy' : 'other';
      const entry = { at: new Date().toISOString(), method: req.method, path: url.pathname, credential, tls: true };
      entries.push(entry);
      const done = (status, action) => { entry.status = status; entry.action = action; };
      try {
        if (url.pathname === '/api/hello') { done(200, 'hello'); res.writeHead(200, { 'content-length': 0 }); return res.end(); }
        if (credential !== 'dummy') { done(401, `refused: credential ${credential}`); return reply(res, 401, apiError('authentication_error', 'tls-spike: dummy key required')); }
        if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') { done(200, 'count_tokens'); return reply(res, 200, { input_tokens: 10 }); }
        if (req.method !== 'POST' || url.pathname !== '/v1/messages') { done(404, 'not scripted'); return reply(res, 404, apiError('not_found_error', 'tls-spike: not scripted')); }
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* a body is not needed for the spike */ }
        done(200, 'messages');
        if (body.stream === true) return sse(res, body.model);
        return reply(res, 200, message(body.model));
      } catch {
        done(500, 'fake failed');
        if (!res.headersSent) reply(res, 500, apiError('api_error', 'tls-spike: fake failed'));
      }
    });
  });
  server.on('tlsClientError', err => tlsErrors.push({ at: new Date().toISOString(), message: String(err && err.message).slice(0, 200), code: err && err.code }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  return {
    port: server.address().port, host, entries, tlsErrors,
    reset() { entries.length = 0; tlsErrors.length = 0; },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
