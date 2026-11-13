// Proxy settings from config.json (written by `do-it-all-claude-code init`), with the upstream allowlist.
//   config.json: { "proxyPort", "daemonPort", "proxy": { "upstream", "allowedUpstreams", "tokenDailyCapUsd", "dailyCapUsd" } }
// The upstream is where the real key is sent, so it must be an https origin on the built-in list or one the
// user added with `do-it-all-claude-code proxy allow-upstream` (config.json is in the router home, never a project
// file). Only tests may use a plain-http loopback upstream.
import fs from 'node:fs';
import path from 'node:path';

export const BUILTIN_UPSTREAMS: readonly string[] = ['https://api.anthropic.com'];
export const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

/** Decision 131: daily caps applied by default; the user changes them in config.json. */
export const DEFAULT_TOKEN_DAILY_CAP_USD = 100;
export const DEFAULT_DAILY_CAP_USD = 300;

/** Time to receive the upstream's response headers; the stream itself has no proxy timeout. */
export const HEADERS_TIMEOUT_MS = 30_000;

/** Tests only: a plain-http upstream on the loopback address (the fake upstream). */
export const TEST_UPSTREAM_ENV = 'DO_IT_ALL_CLAUDE_CODE_PROXY_TEST_UPSTREAM';
const LOOPBACK_HTTP = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

export interface ProxySettings {
  port: number;
  upstream: URL;
  /** The upstream is the plain-http test fake (never in normal use). */
  testUpstream: boolean;
  tokenDailyCapUsd: number;
  dailyCapUsd: number;
  daemonPort?: number;
  headersTimeoutMs: number;
  /** Decision 157: serve HTTPS with the router's local certificate (config.json proxy.tls, set by the CLI). */
  tls?: { certFile: string; keyFile: string };
}

export class ConfigError extends Error {}

/** The upstream origin, checked against the allowlist. Throws ConfigError. */
export function checkUpstream(raw: string, allowed: readonly string[], testUpstream?: string): { url: URL; test: boolean } {
  if (testUpstream !== undefined) {
    if (!LOOPBACK_HTTP.test(testUpstream)) throw new ConfigError(`test upstream must be http://127.0.0.1:<port>, got ${testUpstream}`);
    return { url: new URL(testUpstream), test: true };
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new ConfigError(`upstream is not a URL: ${raw}`); }
  if (url.protocol !== 'https:') throw new ConfigError(`upstream must be https: ${raw}`);
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new ConfigError(`upstream must be an origin (scheme, host, port) only: ${raw}`);
  }
  const origin = url.origin;
  const list = [...BUILTIN_UPSTREAMS, ...allowed].map(o => { try { return new URL(o).origin; } catch { return ''; } });
  if (!list.includes(origin)) throw new ConfigError(`upstream ${origin} is not on the allowlist (add it with do-it-all-claude-code proxy allow-upstream)`);
  return { url: new URL(origin), test: false };
}

const positive = (v: unknown, fallback: number, name: string, warnings: string[]): number => {
  if (v === undefined) return fallback;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  warnings.push(`config.proxy.${name} ignored: ${JSON.stringify(v)} is not a positive number`);
  return fallback;
};

export function loadSettings(configFile: string, warnings: string[] = []): ProxySettings {
  let raw: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) raw = v as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError(`invalid config file ${configFile}: ${(e as Error).message}`);
  }
  const p = raw.proxy && typeof raw.proxy === 'object' && !Array.isArray(raw.proxy) ? raw.proxy as Record<string, unknown> : {};
  const port = raw.proxyPort;
  if (!Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65535) throw new ConfigError('config.proxyPort must be a port number (run do-it-all-claude-code init --mode api)');
  const allowed = Array.isArray(p.allowedUpstreams) ? p.allowedUpstreams.filter((x): x is string => typeof x === 'string') : [];
  // B1: the settings loader never honours a test-upstream environment switch in production. Tests inject a
  // loopback http upstream by constructing ProxySettings with checkUpstream('', [], 'http://127.0.0.1:<port>').
  const { url, test } = checkUpstream(typeof p.upstream === 'string' ? p.upstream : DEFAULT_UPSTREAM, allowed);
  const daemonPort = raw.daemonPort;
  // decision 157: Claude Code then talks to https://127.0.0.1:<port> and trusts only this certificate, so the proxy
  // must not start on plain HTTP instead (a missing certificate is an error, not a fallback)
  let tls: ProxySettings['tls'];
  if (p.tls === true) {
    const dir = path.join(path.dirname(configFile), 'tls');
    tls = { certFile: path.join(dir, 'proxy-cert.pem'), keyFile: path.join(dir, 'proxy-key.pem') };
    for (const f of [tls.certFile, tls.keyFile]) if (!fs.existsSync(f)) throw new ConfigError(`proxy.tls is on but ${f} is missing: run do-it-all-claude-code mode api`);
  }
  return {
    port: port as number,
    upstream: url,
    testUpstream: test,
    tokenDailyCapUsd: positive(p.tokenDailyCapUsd, DEFAULT_TOKEN_DAILY_CAP_USD, 'tokenDailyCapUsd', warnings),
    dailyCapUsd: positive(p.dailyCapUsd, DEFAULT_DAILY_CAP_USD, 'dailyCapUsd', warnings),
    ...(Number.isInteger(daemonPort) && (daemonPort as number) > 0 ? { daemonPort: daemonPort as number } : {}),
    headersTimeoutMs: HEADERS_TIMEOUT_MS,
    ...(tls ? { tls } : {}),
  };
}

/** TLS verification is never off for the upstream that receives the key. */
export function checkTlsEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new ConfigError('NODE_TLS_REJECT_UNAUTHORIZED=0 is set: the proxy does not send the API key without TLS verification');
  }
}
