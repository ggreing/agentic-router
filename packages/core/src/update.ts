// Decision 163: tell the user when a newer release exists (opt-in, no automatic update). The rules and the one
// request, shared by the daemon (at most once a day while config.updateCheck is "on") and
// `do-it-all-claude-code update check`.
//   request   GET https://api.github.com/repos/ggreing/do-it-all-claude-code/releases?per_page=20, not
//             /releases/latest, which leaves out pre-releases (every release so far is one). No auth, a generic
//             User-Agent, If-None-Match with the last ETag, 5 s, at most UPDATE_MAX_BODY bytes. Through the
//             corporate proxy the way the proxy package goes out (egress.ts); a proxy setting that cannot be used
//             skips the check, and the request never goes around the proxy.
//   response  untrusted. Only tag_name of releases that are not drafts, and only a tag of the form
//             v<major>.<minor>.<patch>[-<pre-release>]; the highest by semver precedence wins. Nothing else in it
//             (name, body, html_url) is kept or shown: the release link is built here from the tag.
//   state     <home>/update.json { version: 1, latest, checkedAt, attemptedAt, etag, lastError, notified }, 0600.
//             Every field is checked again when it is read.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { EgressError, agentProxyEnv, upstreamProxy } from './egress.ts';

export const RELEASES_HOST = 'api.github.com';
export const RELEASES_PATH = '/repos/ggreing/do-it-all-claude-code/releases?per_page=20';
export const RELEASE_PAGE = 'https://github.com/ggreing/do-it-all-claude-code/releases/tag/';
export const UPDATE_USER_AGENT = 'do-it-all-claude-code-update-check';
export const UPDATE_TIMEOUT_MS = 5000;
/** 20 releases with their notes are well under this; a larger answer is not read on. */
export const UPDATE_MAX_BODY = 2 * 1024 * 1024;
/** At most one request per this interval while the check is on (and one notice per version). */
export const UPDATE_INTERVAL_MS = 24 * 3600_000;
export const UPDATE_FILE = 'update.json';

// ------------------------------------------------------------------ tags and semver order

const NUM = '(0|[1-9]\\d{0,8})';
const PRE_ID = '(?:0|[1-9]\\d{0,8}|\\d*[A-Za-z][0-9A-Za-z]*)';
/** v<major>.<minor>.<patch>[-<pre-release>]: semver numbers (no leading zeros), pre-release identifiers of letters and digits. */
const TAG_RE = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?$`);
const MAX_TAG = 64;

export interface Version { major: number; minor: number; patch: number; pre: string[] }

/** A release tag as a version; null for anything that is not exactly such a tag. */
export function parseTag(tag: unknown): Version | null {
  if (typeof tag !== 'string' || tag.length > MAX_TAG) return null;
  const m = TAG_RE.exec(tag);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}
/** A version as package.json has it ("0.3.0", no v). */
export const parseVersion = (v: unknown): Version | null => (typeof v === 'string' ? parseTag(`v${v}`) : null);
/** True for a tag parseTag accepts (what may be stored, shown or put in a link). */
export const isReleaseTag = (tag: unknown): tag is string => parseTag(tag) !== null;

const isNumeric = (id: string) => /^\d+$/.test(id);
/** Semver precedence: numbers first; a pre-release is lower than its release; identifiers compared one by one. */
export function compareVersions(a: Version, b: Version): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = isNumeric(x), ny = isNumeric(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;              // numeric identifiers are lower than alphanumeric ones
    return x < y ? -1 : 1;                          // ASCII order
  }
  return 0;
}

/** The highest release tag in a GitHub releases answer, drafts left out; null when there is none. */
export function latestReleaseTag(releases: unknown): string | null {
  if (!Array.isArray(releases)) return null;
  let best: { tag: string; v: Version } | null = null;
  for (const r of releases) {
    if (!r || typeof r !== 'object' || (r as { draft?: unknown }).draft !== false) continue;
    const tag = (r as { tag_name?: unknown }).tag_name;
    const v = parseTag(tag);
    if (v && (!best || compareVersions(v, best.v) > 0)) best = { tag: tag as string, v };
  }
  return best?.tag ?? null;
}

/** The release page of a tag, built here (never taken from the answer). */
export function releaseLink(tag: string): string {
  if (!isReleaseTag(tag)) throw new Error('not a release tag');
  return `${RELEASE_PAGE}${tag}`;
}

export interface UpdateNotice {
  /** The newer version without the v ("0.4.0"), the running one, and the release page. */
  latest: string;
  current: string;
  link: string;
}
/** The notice when `latestTag` is newer than the running version; null otherwise (or when either is not a version). */
export function updateNotice(latestTag: unknown, current: unknown): UpdateNotice | null {
  const l = parseTag(latestTag), c = parseVersion(current);
  if (!l || !c || compareVersions(l, c) <= 0) return null;
  return { latest: (latestTag as string).slice(1), current: current as string, link: releaseLink(latestTag as string) };
}
/** What the session start shows (and status and doctor). */
export const updateMessage = (n: UpdateNotice): string => `Do It All Claude Code ${n.latest} is available (you have ${n.current}): ${n.link}`;

// ------------------------------------------------------------------ why an attempt failed

/** A proxy setting that cannot be used, in fixed words (the message itself names the user's proxy). */
export const SKIP_REASONS = {
  not_url: 'skipped: the proxy setting is not a URL',
  scheme: 'skipped: the proxy is not http:// or https://',
  node: 'skipped: this Node has no built-in proxy support (24.5 or later is needed)',
  other: 'skipped: the proxy setting cannot be used',
} as const;
const FIXED_REASONS: ReadonlySet<string> = new Set([
  ...Object.values(SKIP_REASONS), 'the answer is too large', 'the answer is not JSON', 'the answer broke off', 'the request failed',
]);
/** The shown form of a failure that update.json does not have in one of the forms this code writes. */
export const UNKNOWN_REASON = 'a reason not recorded in a known form';
/** A failure reason this code writes: HTTP <status>, a Node error code, "no answer within <n> s", or a fixed phrase. */
export const isReason = (v: unknown): v is string => typeof v === 'string'
  && (FIXED_REASONS.has(v) || /^HTTP [1-5]\d\d$/.test(v) || /^[A-Z][A-Z0-9_]{1,59}$/.test(v) || /^no answer within \d{1,4} s$/.test(v));

// ------------------------------------------------------------------ the state file

export interface UpdateState {
  version: 1;
  /** The highest release tag of the last successful check. */
  latest?: string;
  /** The last successful check, and the last attempt (successful or not), ISO times. */
  checkedAt?: string;
  attemptedAt?: string;
  /** The ETag of the last full answer, sent back as If-None-Match. */
  etag?: string;
  /** Why the last attempt failed (this code's own words, never text from the answer). */
  lastError?: string;
  /** The session-start notice: the version it was shown for, and when. */
  notified?: { version: string; at: string };
}

/** An entity tag as RFC 9110 has it, bounded: the only value from a response header that is kept. */
const ETAG_RE = /^(?:W\/)?"[\x21\x23-\x7e]{0,200}"$/;
export const isEtag = (v: unknown): v is string => typeof v === 'string' && ETAG_RE.test(v);
/** The form toISOString writes; Date.parse alone also takes free text ("(anything) 1 Jan 2026"). */
const isTime = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) && Number.isFinite(Date.parse(v));

export const updateFile = (home: string): string => path.join(home, UPDATE_FILE);

/** The state, with every field that is not what it should be left out (a missing or broken file is an empty state). */
export function readUpdateState(home: string): UpdateState {
  let raw: Record<string, unknown> = {};
  try {
    const j = JSON.parse(fs.readFileSync(updateFile(home), 'utf8')) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) raw = j as Record<string, unknown>;
  } catch { /* none yet */ }
  const s: UpdateState = { version: 1 };
  if (isReleaseTag(raw.latest)) s.latest = raw.latest;
  if (isTime(raw.checkedAt)) s.checkedAt = raw.checkedAt;
  if (isTime(raw.attemptedAt)) s.attemptedAt = raw.attemptedAt;
  if (isEtag(raw.etag)) s.etag = raw.etag;
  if (raw.lastError !== undefined) s.lastError = isReason(raw.lastError) ? raw.lastError : UNKNOWN_REASON;
  const n = raw.notified as { version?: unknown; at?: unknown } | undefined;
  if (n && typeof n === 'object' && isReleaseTag(n.version) && isTime(n.at)) s.notified = { version: n.version, at: n.at };
  return s;
}

/** Writes the state, user-only (0600), through a temp file and a rename. */
export function writeUpdateState(home: string, s: UpdateState): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = updateFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------ the request

export type FetchResult =
  | { ok: true; notModified: true }
  | { ok: true; notModified: false; latest: string | null; etag?: string }
  | { ok: false; reason: string };

export interface FetchOptions {
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  etag?: string;
  timeoutMs?: number;
  maxBody?: number;
  /** Tests only: where the request goes instead of https://api.github.com (a local server). */
  target?: { protocol: 'http:' | 'https:'; host: string; port: number; ca?: string };
}

/** One request for the release list. Never throws; never resolves with anything from the answer but a checked tag and ETag. */
export function fetchLatestRelease(o: FetchOptions = {}): Promise<FetchResult> {
  let proxy: ReturnType<typeof upstreamProxy>;
  try { proxy = upstreamProxy(o.env ?? process.env, o.nodeVersion); }
  catch (e) { return Promise.resolve({ ok: false, reason: e instanceof EgressError ? SKIP_REASONS[e.kind] : SKIP_REASONS.other }); }
  const target = o.target ?? { protocol: 'https:' as const, host: RELEASES_HOST, port: 443 };
  const maxBody = o.maxBody ?? UPDATE_MAX_BODY;
  const timeoutMs = o.timeoutMs ?? UPDATE_TIMEOUT_MS;
  const mod = target.protocol === 'http:' ? http : https;
  const agent = target.protocol === 'http:'
    ? new http.Agent({ ...(proxy ? { proxyEnv: { HTTP_PROXY: proxy.url.href, NO_PROXY: proxy.noProxy } } : {}) })
    : new https.Agent({ ...(proxy ? { proxyEnv: agentProxyEnv(proxy) } : {}), ...(target.ca ? { ca: target.ca } : {}) });
  return new Promise(resolve => {
    let settled = false;
    const done = (r: FetchResult) => { if (settled) return; settled = true; clearTimeout(timer); agent.destroy(); resolve(r); };
    const req = mod.request({
      host: target.host, port: target.port, method: 'GET', path: RELEASES_PATH, agent,
      headers: {
        accept: 'application/vnd.github+json', 'user-agent': UPDATE_USER_AGENT,
        ...(o.etag && isEtag(o.etag) ? { 'if-none-match': o.etag } : {}),
      },
    }, res => {
      const status = res.statusCode ?? 0;
      if (status === 304) { res.resume(); done({ ok: true, notModified: true }); return; }
      if (status !== 200) { res.resume(); done({ ok: false, reason: `HTTP ${status}` }); return; }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBody) { req.destroy(); done({ ok: false, reason: 'the answer is too large' }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBody) { req.destroy(); done({ ok: false, reason: 'the answer is too large' }); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        let json: unknown;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { done({ ok: false, reason: 'the answer is not JSON' }); return; }
        const etag = res.headers.etag;
        done({ ok: true, notModified: false, latest: latestReleaseTag(json), ...(isEtag(etag) ? { etag } : {}) });
      });
      res.on('error', () => done({ ok: false, reason: 'the answer broke off' }));
    });
    const timer = setTimeout(() => { req.destroy(); done({ ok: false, reason: `no answer within ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
    timer.unref();
    req.on('error', e => { const code = (e as NodeJS.ErrnoException).code; done({ ok: false, reason: isReason(code) ? code : 'the request failed' }); });
    req.end();
  });
}

/**
 * One check: the request (with the stored ETag), then the state updated and written. A failure keeps the last
 * result and records why; an answer without a usable tag leaves no known latest.
 */
export async function checkForUpdate(home: string, o: FetchOptions & { now?: Date } = {}): Promise<{ state: UpdateState; result: FetchResult }> {
  const now = (o.now ?? new Date()).toISOString();
  const before = readUpdateState(home);
  const result = await fetchLatestRelease({ ...o, ...(before.latest && before.etag ? { etag: before.etag } : {}) });
  const next: UpdateState = { ...readUpdateState(home), attemptedAt: now };   // read again: a notice may have been recorded meanwhile
  if (result.ok) {
    next.checkedAt = now;
    delete next.lastError;
    if (!result.notModified) {
      if (result.latest) next.latest = result.latest; else delete next.latest;
      if (result.etag) next.etag = result.etag; else delete next.etag;
    }
  } else next.lastError = result.reason;
  writeUpdateState(home, next);
  return { state: next, result };
}
