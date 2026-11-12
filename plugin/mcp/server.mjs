#!/usr/bin/env node
// agentic-router MCP server: a dependency-free stdio JSON-RPC relay between Claude Code and the local
// daemon (decision 127). Same single-file, no-dependency style as relay.mjs.
//
// Framing: one JSON-RPC 2.0 message per line on stdin/stdout, UTF-8, '\n' only. Nothing but JSON lines
// goes to stdout; logs go to stderr. Methods: initialize, notifications/initialized (no reply), ping,
// tools/list (from tools.json), tools/call (forwarded to the daemon). Unknown method -> -32601; an
// unparseable line -> -32700; other notifications are ignored; stdin end exits the process.
//
// Every tool failure is an MCP result with isError:true (NOT a JSON-RPC error), so the lead reads the
// text as the tool's error and keeps working. A daemon that is down, slow, or errors yields
// daemon_unreachable; no tool ever blocks the session (hooks remain the system of record).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ENDPOINT = '/router/v1/tools/call';
const CALL_TIMEOUT_MS = 10_000;
const INSTANCE_ID = randomUUID();

// MCP protocol versions this server understands; the tool surface (name, description, inputSchema, text
// content, isError) is identical across them. Negotiation echoes the client's version when listed, else
// answers the latest (the first entry) — 2025-11-25 lifecycle rule.
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_VERSION = SUPPORTED_VERSIONS[0];

const HERE = path.dirname(fileURLToPath(import.meta.url));

function serverVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

// ---------------------------------------------------------------- config / token (mirrors relay.mjs)
function routerHome() {
  return process.env.AGENTIC_ROUTER_HOME || path.join(os.homedir(), '.agentic-router');
}
function readConfig(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { return null; }
}
function readToken(home) {
  try { return fs.readFileSync(path.join(home, 'token'), 'utf8').trim(); } catch { return null; }
}

// tools.json sits beside this file (written from core's schemas by a build step); an env var overrides it.
function toolsPath() {
  return process.env.AGENTIC_ROUTER_TOOLS || path.join(HERE, 'tools.json');
}
function loadTools() {
  try {
    const j = JSON.parse(fs.readFileSync(toolsPath(), 'utf8'));
    const arr = Array.isArray(j) ? j : Array.isArray(j?.tools) ? j.tools : [];
    return arr.filter(t => t && typeof t.name === 'string');
  } catch (e) {
    process.stderr.write(`[agentic-router mcp] tools.json unreadable: ${e?.message ?? e}\n`);
    return [];
  }
}

// ---------------------------------------------------------------- daemon POST
function post({ port, token, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    import('node:http').then(({ request }) => {
      const req = request({
        host: '127.0.0.1', port, path: ENDPOINT, method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${token}`,
          host: `127.0.0.1:${port}`,
        },
        timeout: timeoutMs,
      }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', d => { data += d; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`daemon status ${res.statusCode}`));
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.write(body);
      req.end();
    }).catch(reject);
  });
}

// ---------------------------------------------------------------- MCP result helpers
function textResult(obj, isError = false) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], isError };
}
function unreachableResult() {
  return textResult('[agentic-router] daemon_unreachable: the router is not running. Continue without this tool; do not retry.', true);
}

/**
 * Maps the daemon's reply to an MCP tools/call result. The daemon SHOULD return the MCP result itself
 * ({ content:[...], isError? }); if it returns a bare JSON object instead, it is wrapped in one text block.
 */
function mapDaemonReply(data) {
  let body;
  try { body = JSON.parse(data); } catch { return textResult('[agentic-router] internal: invalid daemon response', true); }
  if (body && Array.isArray(body.content)) return { content: body.content, isError: !!body.isError };
  return textResult(body, !!(body && body.isError));
}

async function callTool(params) {
  const name = params && typeof params.name === 'string' ? params.name : '';
  if (!name) return textResult('[agentic-router] invalid_input: a tool name is required', true);
  const input = params && params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
  const home = routerHome();
  const cfg = readConfig(home);
  const token = readToken(home);
  const port = cfg && typeof cfg.daemonPort === 'number' ? cfg.daemonPort : null;
  if (!port || !token) return unreachableResult();   // before init / no daemon
  // Match core RouterToolCall: omit optional fields rather than sending null (strict schema).
  const bind = { instanceId: INSTANCE_ID };
  if (process.env.CLAUDE_CODE_SESSION_ID) bind.spawnSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (process.env.CLAUDE_PROJECT_DIR) bind.projectDir = process.env.CLAUDE_PROJECT_DIR;
  const payload = { tool: name, input, bind };
  if (params && params._meta && typeof params._meta === 'object') payload.meta = params._meta;
  const body = JSON.stringify(payload);
  try { return mapDaemonReply(await post({ port, token, body, timeoutMs: CALL_TIMEOUT_MS })); }
  catch { return unreachableResult(); }
}

// ---------------------------------------------------------------- JSON-RPC framing
function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function reply(id, result) { write({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

function negotiate(params) {
  const v = params && params.protocolVersion;
  return typeof v === 'string' && SUPPORTED_VERSIONS.includes(v) ? v : LATEST_VERSION;
}

export async function handleMessage(msg) {
  if (Array.isArray(msg)) { process.stderr.write('[agentic-router mcp] JSON-RPC batches are not supported\n'); return; }
  if (!msg || typeof msg !== 'object') return;
  const isRequest = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null && msg.id !== undefined;
  const method = typeof msg.method === 'string' ? msg.method : null;

  if (!isRequest) return;                    // notification (incl. notifications/initialized): no reply
  if (!method) return replyError(msg.id, -32600, 'invalid request: no method');

  switch (method) {
    case 'initialize':
      return reply(msg.id, { protocolVersion: negotiate(msg.params), capabilities: { tools: {} }, serverInfo: { name: 'agentic-router', version: serverVersion() } });
    case 'ping':
      return reply(msg.id, {});
    case 'tools/list':
      return reply(msg.id, { tools: loadTools() });
    case 'tools/call':
      return reply(msg.id, await callTool(msg.params));
    default:
      return replyError(msg.id, -32601, `method not found: ${method}`);
  }
}

/** Splits a UTF-8 stream into lines ('\n'; a trailing '\r' is stripped) and dispatches each as JSON-RPC. */
export function createLineReader(onMessage) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let nl;
      const pending = [];
      while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { replyError(null, -32700, 'parse error'); continue; }
        pending.push(onMessage(msg));
      }
      return Promise.all(pending);
    },
  };
}

function isMain() {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const real = p => { try { return (fs.realpathSync.native || fs.realpathSync)(p); } catch { return path.resolve(p); } };
    return real(argv1) === real(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) {
  const reader = createLineReader(handleMessage);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { void reader.push(d); });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
}
