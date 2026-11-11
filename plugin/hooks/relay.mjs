#!/usr/bin/env node
// agentic-router relay: forwards a Claude Code hook event to the local daemon and writes the
// daemon's response to stdout verbatim. Dependency-free single file (decisions 54, 55).
//
// Fail-open: if the daemon is down, slow, or errors, the event is appended to the local spool
// (replayed when the daemon restarts) and the hook passes — Claude Code then behaves exactly as
// it would with no plugin. The only thing written to the spool or any log is masked.
//
// Usage (hooks.json): node relay.mjs <EventName>
//   argv[2] is the Claude Code event name; it sets the per-event timeout and the pre_compact
//   special case (pre_compact passes with EMPTY output on failure, not "{}").
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const EVENT = process.argv[2] || '';
const ENDPOINT = '/router/v1/hooks/claude-code';

// Per-event timeout (ms). SubagentStop waits for the daemon's verify run (up to ~240s); the rest are short.
const TIMEOUTS = { SubagentStop: 300_000 };
const DEFAULT_TIMEOUT = 10_000;

function routerHome() {
  return process.env.AGENTIC_ROUTER_HOME || path.join(os.homedir(), '.agentic-router');
}

// ---------------------------------------------------------------- masking (mirrors core/security.ts redact)
// Kept in sync with core/security.ts SECRET_PATTERNS (relay has no dependencies, so it carries its own copy).
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  // header or JSON field holding a credential, with or without quotes and an auth scheme
  /(authorization|x-api-key|api[-_]?key|access[-_]?token|auth[-_]?token|secret)["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?[^\s"',}]{8,}/gi,
  /\b(bearer|basic|token)\s+[A-Za-z0-9+/=._~-]{12,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,              // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g,                      // AWS access key id
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,      // JWT
  /\bANTHROPIC_[A-Z_]*\s*=\s*\S+/g,             // ANTHROPIC_API_KEY=..., ANTHROPIC_AUTH_TOKEN=...
];
export function redact(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, m => m.slice(0, 7) + '…[REDACTED]');
  return out;
}

// ---------------------------------------------------------------- verify env passthrough (decision 99)
// Kept in sync with core/security.ts VERIFY_ENV_PASSTHROUGH (relay is dependency-free). A test checks it.
export const VERIFY_ENV_PASSTHROUGH = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'ComSpec',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'PYENV_VERSION', 'PYTHONPATH', 'POETRY_ACTIVE',
  'NVM_BIN', 'NVM_DIR', 'VOLTA_HOME', 'FNM_MULTISHELL_PATH', 'NODE_PATH',
  'JAVA_HOME', 'GOPATH', 'GOROOT', 'GOFLAGS', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'CI',
];
const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

function projectVerifyEnvNames() {
  const base = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(base, '.agentic-router', 'policy.json'), 'utf8'));
    return Array.isArray(j.verifyEnv) ? j.verifyEnv.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}
/** { name: value } for the allowed verify env vars present in this process, excluding secret-looking names. */
export function buildVerifyEnv(env = process.env, extraNames = projectVerifyEnvNames()) {
  const out = {};
  for (const name of [...VERIFY_ENV_PASSTHROUGH, ...extraNames]) {
    if (name === 'NODE_OPTIONS' || SECRET_NAME_RE.test(name)) continue;
    const v = env[name];
    if (typeof v === 'string') out[name] = v;
  }
  return out;
}

/** Diagnostics the daemon's doctor/status compares against its own (decision 97). */
function routerClientInfo(home, port) {
  return { node: process.execPath, nodeVersion: process.versions.node, routerHome: home, port };
}

// ---------------------------------------------------------------- config / token
function readConfig(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); }
  catch { return null; }
}
function readToken(home) {
  try { return fs.readFileSync(path.join(home, 'token'), 'utf8').trim(); }
  catch { return null; }
}

// ---------------------------------------------------------------- spool (decision 100)
const SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;     // drop events older than 24h
const SPOOL_MAX_BYTES = 20 * 1024 * 1024;         // keep the whole spool under 20MB

/** Deletes spool files older than 24h, then (oldest first) until the total is under the size cap. */
export function cleanSpool(dir) {
  let entries;
  try { entries = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    return { p, mtime: st.mtimeMs, size: st.size };
  }); } catch { return; }
  const now = Date.now();
  for (const e of entries) if (now - e.mtime > SPOOL_MAX_AGE_MS) { try { fs.rmSync(e.p); e.size = -1; } catch { /* ignore */ } }
  let remaining = entries.filter(e => e.size >= 0).sort((a, b) => a.mtime - b.mtime);
  let total = remaining.reduce((s, e) => s + e.size, 0);
  for (const e of remaining) {
    if (total <= SPOOL_MAX_BYTES) break;
    try { fs.rmSync(e.p); total -= e.size; } catch { /* ignore */ }
  }
}

/** Appends one masked event to spool/<ISO>-<event>-<rand>.jsonl: one line `{receivedAt, input}`. */
export function spool(home, eventInput, receivedAt) {
  const dir = path.join(home, 'spool');
  try {
    fs.mkdirSync(dir, { recursive: true });
    cleanSpool(dir);                              // prune before writing (decision 100)
    const stamp = receivedAt.replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}-${EVENT || 'event'}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
    const line = redact(JSON.stringify({ receivedAt, input: eventInput })) + '\n';
    fs.writeFileSync(file, line);
  } catch { /* spool is best-effort; never block the hook on a spool failure */ }
}

// ---------------------------------------------------------------- daemon POST
function post({ port, token, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // node:http is loaded lazily so the common (daemon-up) path stays small.
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

// ---------------------------------------------------------------- main
/** What the hook writes to stdout when the daemon can't be reached. pre_compact must stay empty. */
export function fallbackOutput(event) {
  return event === 'PreCompact' ? '' : '{}';
}

export async function relay(raw, { home = routerHome(), write = s => process.stdout.write(s) } = {}) {
  const receivedAt = new Date().toISOString();
  let input;
  try { input = JSON.parse(raw); } catch {
    write(fallbackOutput(EVENT));           // unparseable: pass through, nothing to spool
    return;
  }

  const cfg = readConfig(home);
  const token = readToken(home);
  const port = cfg && typeof cfg.daemonPort === 'number' ? cfg.daemonPort : null;
  if (!port || !token) {
    // D5 (decision 100): before `init` (no config/token) there is nothing to replay to — pass, don't spool.
    write(fallbackOutput(EVENT));
    return;
  }

  // Augment the body for two events (the daemon reads these from the raw input; spool keeps them too).
  if (isRecord(input)) {
    if (EVENT === 'SessionStart') input.routerClient = routerClientInfo(home, port);   // D2: doctor/status compare
    else if (EVENT === 'SubagentStart') input.verifyEnv = buildVerifyEnv();            // D4: verify env passthrough
  }

  const timeoutMs = TIMEOUTS[EVENT] ?? DEFAULT_TIMEOUT;
  try {
    const body = JSON.stringify(input);
    const response = await post({ port, token, body, timeoutMs });
    write(response);                        // verbatim: JSON for most events, text/plain for pre_compact
  } catch {
    spool(home, input, receivedAt);         // daemon down / slow / error: queue for replay, then pass
    write(fallbackOutput(EVENT));
  }
}

function isRecord(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }

/** Real-path comparison so a junction/symlink/npm-link spelling of the plugin dir still runs the hook. */
function isMain() {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const real = p => { try { return (fs.realpathSync.native || fs.realpathSync)(p); } catch { return path.resolve(p); } };
    return real(argv1) === real(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { data += d; });
  process.stdin.on('end', () => { relay(data).then(() => process.exit(0), () => process.exit(0)); });
}
