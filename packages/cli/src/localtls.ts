// Decision 157: local TLS between Claude Code and the API-key proxy. With plain HTTP on 127.0.0.1, a program that
// holds the proxy port while the proxy is down receives the local token and the prompts; over TLS with a
// certificate only this router has, it cannot complete the handshake, so nothing is sent (and Claude Code does not
// fall back to plain HTTP: checked on 2.1.322, scripts/tls-spike).
//
//   certificate   one self-signed LEAF for IP:127.0.0.1 and DNS:localhost (basicConstraints CA:FALSE, keyUsage
//                 digitalSignature, extendedKeyUsage serverAuth), made with openssl (Node has no API that issues one)
//                 into <router home>/tls, key and certificate user-only. Trusted directly, it is accepted itself, and
//                 a certificate made with its key for any other name is refused: the key cannot mint certificates
//                 Claude Code would accept (an older CA:TRUE certificate could; it is remade at the next start or
//                 mode api). Key and certificate are checked as a pair; a pair that does not match is remade.
//   renewal       valid CERT_DAYS; renewed within RENEW_WITHIN_DAYS of its end at init, mode api and start, and by
//                 the supervisor's timer only within TIMER_RENEW_WITHIN_DAYS (or after the end), since Claude Code
//                 sessions started before a renewal trust only the old certificate and need a restart. The proxy
//                 picks a renewed file up without a restart.
//   trust         Claude Code is told through NODE_EXTRA_CA_CERTS in its settings env block. Decision 158 (measured on
//                 Claude Code 2.1.323): that value REPLACES a launch-environment NODE_EXTRA_CA_CERTS, the two are not
//                 merged. So whenever the user has one, in the launch environment or in the settings, the settings
//                 value becomes <home>/tls/ca-bundle.pem: their certificates and the router's. The sources are
//                 recorded; the bundle is rebuilt at renewal and when a source changed (start, mode api). Shell files
//                 are never edited. A settings value of the user's is put back by the other modes and uninstall.
//   no openssl    TLS stays off; the helper's proof check (decision 156 d1) still keeps the token from a squatter.
//   no surprises  prepareTls only decides; the certificate and the bundle are made by materialize(), which the
//                 settings change runs after it was confirmed.
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { routerHome } from '@agentic-router/core';

export const CERT_DAYS = 825;
/** init, mode api and start renew a certificate this close to its end. */
export const RENEW_WITHIN_DAYS = 30;
/** The supervisor's timer renews only this close to the end (or after it): a renewal breaks running sessions. */
export const TIMER_RENEW_WITHIN_DAYS = 3;
/** doctor warns from here on. */
export const WARN_WITHIN_DAYS = 60;
const DAY_MS = 86_400_000;

export interface TlsPaths { dir: string; cert: string; key: string; bundle: string }
export const tlsPaths = (home = routerHome()): TlsPaths => {
  const dir = path.join(home, 'tls');
  return { dir, cert: path.join(dir, 'proxy-cert.pem'), key: path.join(dir, 'proxy-key.pem'), bundle: path.join(dir, 'ca-bundle.pem') };
};

/** openssl: OPENSSL_BIN, then PATH, then the one Git for Windows ships. Undefined when none runs. */
export function findOpenssl(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const candidates = [env.OPENSSL_BIN, 'openssl'];
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
      if (!base) continue;
      candidates.push(path.join(base, 'Git', 'usr', 'bin', 'openssl.exe'), path.join(base, 'Git', 'mingw64', 'bin', 'openssl.exe'));
    }
  }
  for (const c of candidates) {
    if (!c) continue;
    const r = spawnSync(c, ['version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (r.status === 0 && /ssl/i.test(r.stdout)) return c;
  }
  return undefined;
}

export interface CertInfo { notBefore: Date; notAfter: Date; sans: string[]; fingerprint: string; /** a CA certificate (the older shape) */ ca: boolean }
export function certInfo(pem: string): CertInfo | null {
  try {
    const x = new X509Certificate(pem);
    return {
      notBefore: new Date(x.validFrom), notAfter: new Date(x.validTo), fingerprint: x.fingerprint256, ca: x.ca,
      sans: (x.subjectAltName ?? '').split(/,\s*/).map(s => s.trim()).filter(Boolean),
    };
  } catch { return null; }
}
const hasLoopbackSans = (i: CertInfo) => i.sans.includes('IP Address:127.0.0.1') && i.sans.includes('DNS:localhost');

/** Whether a key belongs to a certificate (a renewal that stopped half-way leaves a pair that does not). */
export function pairMatches(certPem: string, keyPem: string): boolean {
  try { return new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem)); } catch { return false; }
}

/** What is wrong with a certificate for the proxy (it cannot be used), and how long it has left. */
export function certProblems(i: CertInfo | null, now = new Date()): { problems: string[]; daysLeft: number } {
  if (!i) return { problems: ['not a readable certificate'], daysLeft: 0 };
  const daysLeft = Math.floor((i.notAfter.getTime() - now.getTime()) / DAY_MS);
  const problems: string[] = [];
  if (i.notBefore.getTime() > now.getTime() + 60_000) problems.push(`not valid before ${i.notBefore.toISOString()}`);
  if (i.notAfter.getTime() <= now.getTime()) problems.push(`expired on ${i.notAfter.toISOString().slice(0, 10)}`);
  if (!hasLoopbackSans(i)) problems.push(`names ${i.sans.join(', ') || 'nothing'}, not IP 127.0.0.1 and DNS localhost`);
  return { problems, daysLeft };
}

/** Every certificate in a PEM text, as SHA-256 fingerprints (to see whether a bundle holds ours). */
export function pemFingerprints(text: string): string[] { return [...pemBlocksOf(text).keys()]; }
/** The PEM certificates in a text, keyed by fingerprint. */
function pemBlocksOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)) {
    try { out.set(new X509Certificate(m[0]).fingerprint256, m[0]); } catch { /* skip a broken block */ }
  }
  return out;
}
/** The PEM certificates of a file (none when it cannot be read). */
const pemBlocks = (file: string): Map<string, string> => { try { return pemBlocksOf(fs.readFileSync(file, 'utf8')); } catch { return new Map(); } };

// A config file (not -addext): it works on old OpenSSL, OpenSSL 3 and the LibreSSL of macOS alike.
const LEAF_CNF = `[req]
distinguished_name = dn
x509_extensions = v3ext
prompt = no
[dn]
CN = agentic-router local proxy
[v3ext]
subjectAltName = IP:127.0.0.1, DNS:localhost
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
`;

/** `usable`: the pair there now still works (a renewal, or a remake of the older shape), so it is kept if remaking fails. */
export type CertNeed = { need: 'none' | 'make' | 'renew'; why?: string; info?: CertInfo; usable?: boolean };

/**
 * What the certificate needs now: a remake (missing, unreadable, a key that does not match, wrong names, not valid
 * now, or the older CA shape when `remakeOldShape`), a renewal (inside `renewWithinDays` of its end), or nothing.
 */
export function certNeed(o: { home?: string; now?: Date; renewWithinDays?: number; remakeOldShape?: boolean } = {}): CertNeed {
  const p = tlsPaths(o.home);
  let pem = '';
  let key = '';
  try { pem = fs.readFileSync(p.cert, 'utf8'); key = fs.readFileSync(p.key, 'utf8'); } catch { return { need: 'make', why: 'there is none yet' }; }
  const info = certInfo(pem);
  if (!info) return { need: 'make', why: 'the certificate cannot be read' };
  if (!pairMatches(pem, key)) return { need: 'make', why: 'the key and the certificate do not match', info };
  const { problems, daysLeft } = certProblems(info, o.now);
  if (problems.length) return { need: 'make', why: problems.join('; '), info };
  if (info.ca && o.remakeOldShape !== false) return { need: 'make', why: 'it is a CA certificate (the older shape): remade as a leaf', info, usable: true };
  if (daysLeft <= (o.renewWithinDays ?? RENEW_WITHIN_DAYS)) return { need: 'renew', why: `${daysLeft} days left`, info, usable: true };
  return { need: 'none', info };
}

/**
 * Makes a new key and leaf certificate with openssl: both written to temporary files, checked (a pair, the names,
 * not a CA), then renamed, the key first and the certificate last. A crash between the two renames leaves a pair
 * that does not match, which certNeed then remakes. Both files user-only, the folder 0700.
 */
export function makeProxyCert(o: { home?: string; openssl: string; days?: number }): { ok: true; info: CertInfo } | { ok: false; reason: string } {
  const p = tlsPaths(o.home);
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(p.dir, 0o700); } catch { /* Windows: the router home's ACL */ }
  const stamp = `${process.pid}.${Date.now()}`;
  const tmpKey = `${p.key}.${stamp}.tmp`;
  const tmpCert = `${p.cert}.${stamp}.tmp`;
  const cnf = path.join(p.dir, `openssl.${stamp}.cnf`);
  try {
    fs.writeFileSync(cnf, LEAF_CNF, { mode: 0o600 });
    const r = spawnSync(o.openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', tmpKey, '-out', tmpCert,
      '-days', String(o.days ?? CERT_DAYS), '-config', cnf], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    let pem = '';
    let key = '';
    try { pem = fs.readFileSync(tmpCert, 'utf8'); key = fs.readFileSync(tmpKey, 'utf8'); } catch { /* below */ }
    const info = r.status === 0 && pem ? certInfo(pem) : null;
    if (!info || !hasLoopbackSans(info) || info.ca || !pairMatches(pem, key)) {
      return { ok: false, reason: `openssl could not make the certificate (${(r.stderr || r.error?.message || 'no output').trim().split('\n')[0]!.slice(0, 160)})` };
    }
    for (const f of [tmpKey, tmpCert]) { try { fs.chmodSync(f, 0o600); } catch { /* Windows */ } }
    fs.renameSync(tmpKey, p.key);
    fs.renameSync(tmpCert, p.cert);
    return { ok: true, info };
  } finally {
    for (const f of [cnf, tmpKey, tmpCert]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
  }
}

export type CertResult =
  | { state: 'kept' | 'created' | 'renewed'; paths: TlsPaths; info: CertInfo; why?: string }
  | { state: 'unavailable'; reason: string };

/** The certificate made or renewed now when certNeed says so (openssl), else kept. */
export function ensureProxyCert(o: { home?: string; openssl?: string | null; now?: Date; days?: number; renewWithinDays?: number; remakeOldShape?: boolean } = {}): CertResult {
  const p = tlsPaths(o.home);
  const n = certNeed(o);
  if (n.need === 'none') return { state: 'kept', paths: p, info: n.info! };
  const openssl = o.openssl === null ? undefined : o.openssl ?? findOpenssl();
  if (!openssl) {
    // a certificate that still works (inside the renewal window, or the older shape) is used until it ends
    if (n.usable && n.info) return { state: 'kept', paths: p, info: n.info, why: n.why };
    return { state: 'unavailable', reason: 'openssl was not found (Git for Windows ships one; or set OPENSSL_BIN)' };
  }
  const m = makeProxyCert({ home: o.home, openssl, ...(o.days ? { days: o.days } : {}) });
  if (!m.ok) return n.usable && n.info ? { state: 'kept', paths: p, info: n.info, why: m.reason } : { state: 'unavailable', reason: m.reason };
  return { state: n.why === 'there is none yet' ? 'created' : 'renewed', paths: p, info: m.info, why: n.why };
}

/**
 * The user's certificates (each source file, in order) plus the router's, once each, in the bundle file (user-only).
 * Returns the sources that could not be read, which are left out.
 */
export function writeBundle(sources: readonly string[], ourCertPem: string, p: TlsPaths): { file: string; unreadable: string[] } {
  const blocks = new Map<string, string>();
  const unreadable: string[] = [];
  for (const s of sources) {
    const b = pemBlocks(s);
    if (!b.size) { unreadable.push(s); continue; }
    for (const [fp, pem] of b) if (!blocks.has(fp)) blocks.set(fp, pem);
  }
  for (const [fp, pem] of pemBlocksOf(ourCertPem)) if (!blocks.has(fp)) blocks.set(fp, pem);
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const tmp = `${p.bundle}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${[...blocks.values()].join('\n')}\n`, { mode: 0o600 });
  fs.renameSync(tmp, p.bundle);
  return { file: p.bundle, unreadable };
}

/** config.json's recorded bundle sources (localTls.bundleFrom), as a list. */
export function bundleSources(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : typeof v === 'string' && v ? [v] : [];
}

/** Whether the bundle holds exactly its sources' certificates and the router's; the sources that cannot be read. */
export function bundleStatus(home: string, sources: readonly string[]): { exists: boolean; current: boolean; unreadable: string[] } {
  const p = tlsPaths(home);
  const unreadable = sources.filter(s => !pemBlocks(s).size);
  if (!fs.existsSync(p.bundle) || !fs.existsSync(p.cert)) return { exists: false, current: false, unreadable };
  const want = new Set<string>();
  for (const s of sources) for (const fp of pemBlocks(s).keys()) want.add(fp);
  for (const fp of pemBlocks(p.cert).keys()) want.add(fp);
  const have = new Set(pemBlocks(p.bundle).keys());
  return { exists: true, current: want.size === have.size && [...want].every(f => have.has(f)), unreadable };
}

/** Decision 158: the bundle rebuilt when it no longer holds exactly its sources' certificates and the router's. */
export function refreshBundle(home: string, sources: readonly string[]): { state: 'none' | 'current' | 'rebuilt'; unreadable: string[] } {
  if (!sources.length) return { state: 'none', unreadable: [] };
  const s = bundleStatus(home, sources);
  if (!fs.existsSync(tlsPaths(home).cert)) return { state: 'none', unreadable: s.unreadable };
  if (s.exists && s.current) return { state: 'current', unreadable: s.unreadable };
  writeBundle(sources, fs.readFileSync(tlsPaths(home).cert, 'utf8'), tlsPaths(home));
  return { state: 'rebuilt', unreadable: s.unreadable };
}

/**
 * The supervisor's look at the certificate. At its start (`at: 'start'`) it renews within RENEW_WITHIN_DAYS and remakes
 * the older shape; on its timer only within TIMER_RENEW_WITHIN_DAYS or after the end. The bundle follows (a renewed
 * certificate, a changed source); sources that cannot be read are reported, not skipped silently. 'off' when proxy
 * mode does not use local TLS.
 */
export function renewTlsIfDue(home = routerHome(), o: { now?: Date; openssl?: string | null; at?: 'start' | 'timer' } = {}):
  { cert: 'off' | 'kept' | 'created' | 'renewed' | 'unavailable'; bundle: 'none' | 'current' | 'rebuilt'; unreadable: string[]; why?: string } {
  let cfg: { apiMode?: unknown; proxy?: { tls?: unknown }; localTls?: { bundleFrom?: unknown } } = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as typeof cfg; } catch { return { cert: 'off', bundle: 'none', unreadable: [] }; }
  if (cfg.apiMode !== 'proxy' || cfg.proxy?.tls !== true) return { cert: 'off', bundle: 'none', unreadable: [] };
  const timer = o.at === 'timer';
  const r = ensureProxyCert({ home, ...(o.now ? { now: o.now } : {}), ...(o.openssl !== undefined ? { openssl: o.openssl } : {}),
    renewWithinDays: timer ? TIMER_RENEW_WITHIN_DAYS : RENEW_WITHIN_DAYS, remakeOldShape: !timer });
  const b = r.state === 'unavailable' ? { state: 'none' as const, unreadable: [] } : refreshBundle(home, bundleSources(cfg.localTls?.bundleFrom));
  return { cert: r.state, bundle: b.state, unreadable: b.unreadable, ...(r.state === 'unavailable' ? { why: r.reason } : r.why ? { why: r.why } : {}) };
}

export type TlsChoice =
  | {
    on: true;
    /** for NODE_EXTRA_CA_CERTS in the settings: the router's certificate, or the bundle */
    caFile: string;
    bundleFrom?: string[];
    note?: string;
    /** what materialize() will do (shown with the settings change); empty when nothing needs making */
    pending: string[];
    /** makes or renews the certificate and writes the bundle; run after the change was confirmed. Throws when it cannot. */
    materialize(): void;
  }
  | { on: false; reason: string };

/**
 * Whether proxy mode can use TLS now, and what NODE_EXTRA_CA_CERTS in Claude Code's settings should be. Decides only:
 * nothing is written until materialize().
 */
export function prepareTls(o: { settingsEnv: Record<string, unknown>; shellEnv: NodeJS.ProcessEnv; home?: string; openssl?: string | null; now?: Date; bundleFrom?: readonly string[] }): TlsChoice {
  const p = tlsPaths(o.home);
  const n = certNeed({ home: o.home, ...(o.now ? { now: o.now } : {}), renewWithinDays: RENEW_WITHIN_DAYS, remakeOldShape: true });
  const pending: string[] = [];
  let openssl: string | undefined;
  if (n.need !== 'none') {
    openssl = o.openssl === null ? undefined : o.openssl ?? findOpenssl();
    const usable = n.usable === true;
    if (!openssl && !usable) return { on: false, reason: 'openssl was not found (Git for Windows ships one; or set OPENSSL_BIN)' };
    if (openssl) pending.push(n.need === 'renew' ? `renew the local TLS certificate (${n.why})` : `make the local TLS certificate in ${p.dir} (${n.why})`);
  }
  const isOurs = (f: string) => path.resolve(f) === path.resolve(p.cert) || path.resolve(f) === path.resolve(p.bundle);
  const shell = o.shellEnv.NODE_EXTRA_CA_CERTS?.trim();
  const set = typeof o.settingsEnv.NODE_EXTRA_CA_CERTS === 'string' ? (o.settingsEnv.NODE_EXTRA_CA_CERTS as string).trim() : '';
  const sources: string[] = [];
  const add = (f: string) => { if (!sources.some(s => path.resolve(s) === path.resolve(f))) sources.push(f); };
  for (const v of [shell, set]) {
    if (!v) continue;
    if (path.resolve(v) === path.resolve(p.bundle)) for (const s of o.bundleFrom ?? []) add(s);   // our bundle: its recorded sources
    else if (!isOurs(v)) add(v);
  }
  const unreadable = sources.filter(s => !pemBlocks(s).size);
  if (sources.length && (pending.length || !bundleStatus(o.home ?? routerHome(), sources).current)) pending.push(`write ${p.bundle} (your certificates and the router's)`);
  const materialize = () => {
    if (openssl && n.need !== 'none') {
      const m = makeProxyCert({ home: o.home, openssl });
      // a pair that still works (the older shape, or one being renewed) is kept when remaking fails; doctor says so
      if (!m.ok && !n.usable) throw new Error(`could not make the local TLS certificate: ${m.reason}`);
    }
    if (sources.length) writeBundle(sources, fs.readFileSync(p.cert, 'utf8'), p);
  };
  if (!sources.length) return { on: true, caFile: p.cert, pending, materialize };
  return {
    on: true, caFile: p.bundle, bundleFrom: sources, pending, materialize,
    note: `your NODE_EXTRA_CA_CERTS (${sources.join(', ')}) and the router's certificate are combined in ${p.bundle}: the settings value replaces the launch one, so both stay trusted${unreadable.length ? `; ${unreadable.join(', ')} cannot be read and is left out` : ''}`,
  };
}
