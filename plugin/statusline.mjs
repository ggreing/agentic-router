#!/usr/bin/env node
// Agentic Router status line for Claude Code (dependency-free, single file).
//
// Reads the status line input JSON on stdin, asks the local daemon for the session's request
// (GET /router/v1/status?session_id=..., port from config.json, Bearer token from the token file)
// and prints one line:  [Router] L2 | architect s3 · coder×2 s1 · reviewer s3 · tester s1 | $0.42
// The cost reads ~$0.42 when it includes estimates and $0.42+? when some subagent costs are unknown.
// A request the lead handles itself (L0) reads: [Router] L0 · direct | $0.00; a level forced by config.forceLevel: [Router] L2 forced | ...
// Daemon down, slow (> 1 s) or unauthorised: [Router] OFF.  No request yet in the session: [Router] idle.
// If config.json has `wrappedStatusLine` (the user's previous status line command), it runs with the
// same stdin and its output is appended after " | "; its failure is ignored. The wrapped command gets
// AGENTIC_ROUTER_STATUSLINE=1; a status line started with it set prints the router segment only, so
// a configuration that wraps this script itself cannot recurse.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DAEMON_TIMEOUT_MS = 1000;
export const WRAPPED_TIMEOUT_MS = 2000;
export const NESTED_ENV = 'AGENTIC_ROUTER_STATUSLINE';
const MAX_STDIN = 256 * 1024;

export function routerHome(env = process.env) {
  return env.AGENTIC_ROUTER_HOME || path.join(os.homedir(), '.agentic-router');
}

// ---------------------------------------------------------------- subscription limit capture (spec 3.8)
// The status line runs on every render, so forwarding rate_limits to the daemon is rate-limited: send only
// when the value changed or the last send is older than this interval. The daemon (limits.ts) parses the
// raw rate_limits object; here we just forward it. Fire-and-(briefly)-wait so a render stays fast.
export const LIMITS_ENDPOINT = '/router/v1/limits';
export const LIMITS_MIN_INTERVAL_MS = 60_000;
const LIMITS_POST_TIMEOUT_MS = 500;
const safeName = s => String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
const limitsHash = rateLimits => { try { return JSON.stringify(rateLimits); } catch { return ''; } };

/** Whether to post rate_limits now, given the last send stamp ({hash, at}). Pure, for the rate limiter. */
export function shouldSendLimits(stamp, rateLimits, now, minIntervalMs = LIMITS_MIN_INTERVAL_MS) {
  const hash = limitsHash(rateLimits);
  if (!hash || hash === '{}' || rateLimits === undefined || rateLimits === null) return false;
  if (!stamp || typeof stamp !== 'object') return true;
  if (stamp.hash !== hash) return true;
  return now - (Number(stamp.at) || 0) >= minIntervalMs;
}

function postLimits({ port, token, sessionId, rateLimits, timeoutMs = LIMITS_POST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ sessionId, rateLimits, at: new Date().toISOString() });
    const req = http.request({
      host: '127.0.0.1', port, path: LIMITS_ENDPOINT, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${token}`, host: `127.0.0.1:${port}` },
      timeout: timeoutMs,
    }, res => { res.resume(); res.on('end', resolve); res.on('error', reject); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Reads the per-session stamp, decides via shouldSendLimits, posts if due, and updates the stamp. Never throws. */
export async function maybeSendLimits({ home, port, token, sessionId, rateLimits, now = Date.now() }) {
  if (!Number.isInteger(port) || port <= 0 || !token || !sessionId) return;
  const dir = path.join(home, 'limits-cache');
  const file = path.join(dir, `${safeName(sessionId)}.json`);
  let stamp;
  try { stamp = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no stamp yet */ }
  if (!shouldSendLimits(stamp, rateLimits, now)) return;
  // Stamp before the POST so rapid renders don't queue duplicate requests even if the POST is slow.
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ hash: limitsHash(rateLimits), at: now })); } catch { /* best effort */ }
  try { await postLimits({ port, token, sessionId, rateLimits }); } catch { /* daemon down/slow: the status line still prints */ }
}

/** One line from a /router/v1/status response; roles with the same step are grouped (coder×2 s1). */
export function formatStatus(view) {
  if (!view || typeof view !== 'object' || !view.request) return '[Router] idle';
  // Decision 87: a lead-direct request (L0) shows "L0 · direct" and only the roles actually dispatched.
  const direct = view.request.leadDirect === true;
  const roles = (Array.isArray(view.roles) ? view.roles : []).filter(r => !direct || r.status !== 'idle');
  const groups = [];
  for (const r of roles) {
    const g = groups.find(x => x.role === r.role && x.step === r.step);
    if (g) g.n++;
    else groups.push({ role: r.role, step: r.step, n: 1 });
  }
  const team = groups.map(g => `${g.role}${g.n > 1 ? `×${g.n}` : ''} ${g.step}`).join(' · ');
  // ~ : the total includes estimates from task notifications; +? : some subagent costs are unknown (decision 84)
  const cost = `${view.costEstimated ? '~' : ''}$${(Number(view.costUsd) || 0).toFixed(2)}${view.costUnknown ? '+?' : ''}`;
  // decision 107: a level forced by config.forceLevel (benchmarks) reads "L2 forced"
  const forced = view.request.forcedFrom ? ' forced' : '';
  return [`[Router] ${view.request.level}${forced}${direct ? ' · direct' : ''}`, team, cost].filter(Boolean).join(' | ');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return undefined; }
}

/** The daemon's status view, or null when it does not answer properly within the time limit. */
export function fetchStatus({ port, token, sessionId, timeoutMs = DAEMON_TIMEOUT_MS }) {
  return new Promise(resolve => {
    if (!Number.isInteger(port) || port <= 0 || !token) return resolve(null);
    let done = false;
    const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
    const req = http.get({ host: '127.0.0.1', port, path: `/router/v1/status${query}`, headers: { authorization: `Bearer ${token}` } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(null);
        try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(null); }
      });
      res.on('error', () => finish(null));
    });
    const timer = setTimeout(() => { req.destroy(); finish(null); }, timeoutMs);
    req.on('error', () => finish(null));
  });
}

/** Runs the wrapped status line command with the same stdin; '' on failure, timeout or no command. */
export function runWrapped(setting, input, timeoutMs = WRAPPED_TIMEOUT_MS, env = process.env) {
  const command = typeof setting === 'string' ? setting : setting && typeof setting.command === 'string' ? setting.command : '';
  if (!command.trim()) return Promise.resolve('');
  return new Promise(resolve => {
    let out = '';
    let done = false;
    const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try {
      child = spawn(command, { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...env, [NESTED_ENV]: '1' } });
    } catch {
      return resolve('');
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(''); }, timeoutMs);
    child.stdout.on('data', c => { out += c; });
    child.on('error', () => finish(''));
    child.on('close', code => finish(code === 0 ? out.replace(/\s+$/, '') : ''));
    child.stdin.on('error', () => { /* the command may not read stdin */ });
    child.stdin.end(input);
  });
}

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { if (data.length < MAX_STDIN) data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export async function statusLine(input, env = process.env) {
  let parsed = {};
  try { parsed = JSON.parse(input); } catch { /* no session: latest request */ }
  const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : undefined;
  const home = routerHome(env);
  const config = readJson(path.join(home, 'config.json')) ?? {};
  const token = readText(path.join(home, 'token'));
  // Forward subscription rate limits to the daemon (rate-limited); runs alongside the status fetch so it
  // adds no latency beyond its own short timeout, and never affects the printed line.
  const limits = (!env[NESTED_ENV] && sessionId && parsed.rate_limits)
    ? maybeSendLimits({ home, port: config.daemonPort, token, sessionId, rateLimits: parsed.rate_limits })
    : Promise.resolve();
  const [view, wrapped] = await Promise.all([
    fetchStatus({ port: config.daemonPort, token, sessionId }),
    env[NESTED_ENV] ? Promise.resolve('') : runWrapped(config.wrappedStatusLine, input, WRAPPED_TIMEOUT_MS, env),
    limits,
  ]);
  const router = view === null ? '[Router] OFF' : formatStatus(view);
  return wrapped ? `${router} | ${wrapped}` : router;
}

// Run directly (not imported by a test)? Compared by real path, so a plugin reached through a junction,
// symlink or `npm link` still runs (environment audit E1).
const real = p => { try { return (fs.realpathSync.native || fs.realpathSync)(p); } catch { return path.resolve(p); } };
const isMain = !!process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    process.stdout.write(`${await statusLine(await readStdin())}\n`);
  } catch {
    process.stdout.write('[Router] OFF\n');
  }
}
