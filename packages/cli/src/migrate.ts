// Decision 161: the product was renamed. When the previous release's home exists and the new one does not,
// `init` offers to move it, and after a yes (or --yes):
//   1. stops the previous release's supervisor, daemon and proxy (the pids are listed in the question): its pid
//      files and stop file, its daemon's graceful shutdown. A pid is touched only while its command line is one of
//      the router's entries and the process started before the file that names it was written (a reused pid
//      belongs to someone else);
//   2. removes the stale endpoint.json and socket, and moves the folder (rename; copy and remove across devices)
//      with the ledger, tokens, TLS certificate and bundle, and config.json, whose values naming the old folder
//      are rewritten;
//   3. backs up Claude Code's user settings (without credentials) and rewrites the entries the router owns:
//      statusLine, apiKeyHelper, env values under the old folder, and plugin and permission entries that name the
//      previous plugin, by exact prefixes only; renames the one-time settings backup;
//   4. moves the API key to the new keychain name (it passes through this process only and is never printed),
//      and deletes the previous entry once the new one is there.
// Only a real folder of this user that holds config.json or a token is moved. When both homes exist, nothing is
// merged: init says so and stops. doctor warns while the old home is left.
//
// Which old home: $AGENTIC_ROUTER_HOME when it is set, else ~/.agentic-router, but the default one only when
// DO_IT_ALL_CLAUDE_CODE_HOME is not set either. A home set by DO_IT_ALL_CLAUDE_CODE_HOME alone is a setup of its
// own (a test, a script, a second profile): the default old home is never moved into it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_SLUG, ROUTER_PLUGIN_NAME, legacyRouterHome, routerHome, sealedCall } from '@do-it-all-claude-code/core';
import { VAULT_SERVICE, VaultError, deleteKey, keyStatus, readKey, storeKey, type VaultErrorCode } from '@do-it-all-claude-code/proxy';
import { isRouterHelper } from './apimode.ts';
import { cliEntry, daemonEntry, isAlive, processInfo } from './daemonctl.ts';
import type { Check } from './doctor.ts';
import { removeEndpointFiles } from './endpointfiles.ts';
import { backupFile, isRouterStatusLine, legacyBackupFile, readJsonFile, writeJsonAtomic, writeMoveBackup } from './setup.ts';
import { readSuperviseStatus, superviseFiles } from './supervise.ts';

/** The keychain service name of the previous release (the account name did not change). */
export const LEGACY_VAULT_SERVICE = LEGACY_SLUG;
const LEGACY_TOOL_PREFIX = `mcp__plugin_${LEGACY_SLUG}_`;
const TOOL_PREFIX = `mcp__plugin_${ROUTER_PLUGIN_NAME}_`;
const LEGACY_REPO = `ggreing/${LEGACY_SLUG}`;
const REPO = `ggreing/${ROUTER_PLUGIN_NAME}`;

const lstat = (p: string) => { try { return fs.lstatSync(p); } catch { return undefined; } };
const emptyDir = (p: string) => { try { return fs.readdirSync(p).length === 0; } catch { return false; } };
const samePath = (a: string, b: string, platform: NodeJS.Platform) => {
  const n = (p: string) => (platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return n(a) === n(b);
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const errText = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.message : String(e));
const octal = (mode: number) => `0${(mode & 0o777).toString(8)}`;

/** The previous release's home that init may move, or undefined (see the header for the rule). */
export function legacyHomeToMove(env: NodeJS.ProcessEnv, userHome: string = os.homedir()): string | undefined {
  const set = (v: string | undefined) => !!v && path.isAbsolute(v);
  if (!set(env.AGENTIC_ROUTER_HOME) && set(env.DO_IT_ALL_CLAUDE_CODE_HOME)) return undefined;
  return legacyRouterHome(env, userHome);
}

/**
 * Whether `dir` is a home init may move: a real folder (not a link), on POSIX owned by `uid`, holding config.json
 * or a token. A folder open to other users is moved and closed afterwards (`looseMode` says it was open).
 */
export function checkOldHome(dir: string, uid: number | undefined = process.getuid?.(), platform: NodeJS.Platform = process.platform): { ok: true; looseMode?: number } | { ok: false; why: string } {
  const st = lstat(dir);
  if (!st) return { ok: false, why: 'it is not there' };
  if (st.isSymbolicLink()) return { ok: false, why: 'it is a link, and init moves only a real folder' };
  if (!st.isDirectory()) return { ok: false, why: 'it is not a folder' };
  if (platform !== 'win32' && uid !== undefined && st.uid !== uid) return { ok: false, why: `it belongs to another user (uid ${st.uid})` };
  if (!lstat(path.join(dir, 'config.json')) && !lstat(path.join(dir, 'token'))) return { ok: false, why: 'it holds no config.json or token, so it is not a router home' };
  return platform !== 'win32' && (st.mode & 0o077) !== 0 ? { ok: true, looseMode: st.mode & 0o777 } : { ok: true };
}

// ------------------------------------------------------------------ paths and settings entries

/** The ways a home path is written: as is, and on Windows with forward slashes and as /c/...; with userHome, ~/... too. */
function homeForms(oldHome: string, newHome: string, platform: NodeJS.Platform, userHome?: string): Array<[string, string]> {
  const forms: Array<[string, string]> = [[oldHome, newHome]];
  if (platform === 'win32') {
    const fwd = (p: string) => p.replace(/\\/g, '/');
    const msys = (p: string) => fwd(p).replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
    forms.push([fwd(oldHome), fwd(newHome)], [msys(oldHome), msys(newHome)]);
  }
  if (userHome) {
    const tilde = (p: string) => {
      const rel = path.relative(userHome, p);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : undefined;
    };
    const o = tilde(oldHome);
    if (o) forms.push([o, tilde(newHome) ?? newHome]);
  }
  return forms;
}

/**
 * The old home must begin the path: before it, the start of the string or a character that cannot be part of a
 * path (`(`, a quote, a space, `=`, a list separator…), or the `//` of an absolute path in a permission rule. A
 * name character or a separator there means the old home is only the tail of another path (/mnt/backup/home/…).
 */
const PATH_START = String.raw`(?<=^|[^A-Za-z0-9._~\-/\\]|(?:^|[^A-Za-z0-9._~\-/\\])/)`;
/** Then the end of the old home: the end of the string, a separator, or a character that ends a path. */
const PATH_END = String.raw`(?=$|[\\/"'\s;,)])`;

/** `s` with the old home replaced by the new one wherever it is a whole path or begins one (every way it is written; any case on Windows). */
export function rehome(s: string, oldHome: string, newHome: string, platform: NodeJS.Platform = process.platform, userHome?: string): string {
  let out = s;
  for (const [a, b] of homeForms(oldHome, newHome, platform, userHome)) {
    out = out.replace(new RegExp(`${PATH_START}${escapeRe(a)}${PATH_END}`, platform === 'win32' ? 'gi' : 'g'), () => b);
  }
  return out;
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map(x => mapStrings(x, f));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

/**
 * A permission rule of the previous release under the new names, by exact prefixes only: the plugin's MCP tool
 * prefix, the agent type (`Agent(agentic-router:…)`), the command at the start of a Bash or PowerShell rule, and
 * the old home's paths. Any other mention (a folder of the user's that has the name in it) is left as it is.
 */
export function renamePermission(rule: string, re: (s: string) => string): string {
  let r = re(rule);
  if (r.startsWith(LEGACY_TOOL_PREFIX)) r = TOOL_PREFIX + r.slice(LEGACY_TOOL_PREFIX.length);
  r = r.replace(/^((?:Agent|Task)\()agentic-router:/, (_m, a: string) => `${a}${ROUTER_PLUGIN_NAME}:`);
  r = r.replace(/^((?:Bash|PowerShell)\()agentic-router(-proxy)?(?=[\s:)]|$)/, (_m, a: string, p: string | undefined) => `${a}${ROUTER_PLUGIN_NAME}${p ?? ''}`);
  return r;
}

/** A marketplace source naming this repository exactly (owner/name, or its GitHub URL), under the new name. */
const renameRepo = (s: string): string => (s === LEGACY_REPO ? REPO
  : s.replace(/^((?:https:\/\/|git@)github\.com[/:])ggreing\/agentic-router((?:\.git)?\/?)$/i, (_m, a: string, b: string) => `${a}${REPO}${b}`));

export interface SettingsMoveInput {
  oldHome: string;
  newHome: string;
  /** This install's status line command and helpers; without them the old home is only replaced in the commands. */
  statusLine?: string;
  helpers?: { localToken: string; key: string };
  platform?: NodeJS.Platform;
  /** For `~/…` forms of the old home in permission rules. */
  userHome?: string;
}

/** Claude Code's user settings with the router entries of the previous release rewritten, and what changed; null when nothing does. */
export function moveSettingsEntries(s: Record<string, any>, i: SettingsMoveInput): { next: Record<string, any>; notes: string[] } | null {
  const re = (x: string) => rehome(x, i.oldHome, i.newHome, i.platform);
  const rePath = (x: string) => rehome(x, i.oldHome, i.newHome, i.platform, i.userHome);
  const next: Record<string, any> = { ...s };
  const notes: string[] = [];
  const sl = s.statusLine;
  if (sl && typeof sl === 'object' && typeof sl.command === 'string' && isRouterStatusLine(sl.command)) {
    const command = i.statusLine ?? re(sl.command);
    if (command !== sl.command) { next.statusLine = { ...sl, command }; notes.push('statusLine: the router status line of this install'); }
  }
  if (isRouterHelper(s.apiKeyHelper)) {
    const helper = i.helpers ? (/key-helper\.mjs/.test(s.apiKeyHelper) ? i.helpers.key : i.helpers.localToken) : re(s.apiKeyHelper);
    if (helper !== s.apiKeyHelper) { next.apiKeyHelper = helper; notes.push('apiKeyHelper: the helper of this install'); }
  }
  if (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) {
    const env: Record<string, unknown> = { ...s.env };
    const moved = Object.keys(env).filter(k => typeof env[k] === 'string' && re(env[k] as string) !== env[k]);
    for (const k of moved) env[k] = re(env[k] as string);
    if (moved.length) { next.env = env; notes.push(`env ${moved.join(', ')}: now under ${i.newHome}`); }
  }
  const p = s.permissions;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const np: Record<string, unknown> = { ...p };
    let n = 0;
    for (const key of ['allow', 'ask', 'deny', 'additionalDirectories']) {
      if (!Array.isArray(p[key])) continue;
      // additionalDirectories are paths: only the old home moves there
      const list = (p[key] as unknown[]).map(x => (typeof x !== 'string' ? x : key === 'additionalDirectories' ? rePath(x) : renamePermission(x, rePath)));
      n += list.filter((x, j) => x !== p[key][j]).length;
      np[key] = list;
    }
    if (n) { next.permissions = np; notes.push(`permissions: ${n} ${n === 1 ? 'entry names' : 'entries name'} the previous release`); }
  }
  const ep = s.enabledPlugins;
  if (ep && typeof ep === 'object' && !Array.isArray(ep)) {
    const old = Object.keys(ep).filter(k => k === LEGACY_SLUG || k.startsWith(`${LEGACY_SLUG}@`));
    if (old.length) {
      next.enabledPlugins = Object.fromEntries(Object.entries(ep).map(([k, v]) => [old.includes(k) ? ROUTER_PLUGIN_NAME + k.slice(LEGACY_SLUG.length) : k, v]));
      notes.push(`enabledPlugins: ${old.join(', ')} under the new plugin name`);
    }
  }
  const mk = s.extraKnownMarketplaces;
  if (mk && typeof mk === 'object' && !Array.isArray(mk)) {
    const nm = mapStrings(mk, x => renameRepo(re(x)));
    if (JSON.stringify(nm) !== JSON.stringify(mk)) { next.extraKnownMarketplaces = nm; notes.push('extraKnownMarketplaces: the repository\'s new name'); }
  }
  return notes.length ? { next, notes } : null;
}

/** config.json in the moved home with every value naming the old home rewritten; the number of values changed. */
export function rehomeConfig(home: string, oldHome: string, platform: NodeJS.Platform = process.platform): number {
  const file = path.join(home, 'config.json');
  const before = readJsonFile<Record<string, unknown> | null>(file, null);
  if (!before) return 0;
  let n = 0;
  const after = mapStrings(before, s => { const r = rehome(s, oldHome, home, platform); if (r !== s) n++; return r; });
  if (n) writeJsonAtomic(file, after, { mode: 0o600 });
  return n;
}

// ------------------------------------------------------------------ the previous release's processes

/**
 * A router supervisor or daemon/proxy entry of either release, recognised by a folder that carries the product's
 * name (a checkout, the CLI package, the @scope/daemon or proxy package). The current install's own entries count
 * too, wherever it lives (as isOurDaemon does).
 */
const SUPERVISOR_CMD = /[\\/](?:agentic-router|do-it-all-claude-code)[\\/](?:packages[\\/]cli[\\/])?(?:src|dist)[\\/]index\.(?:ts|js)\b.*\bsupervise\b/i;
const CHILD_CMD = /[\\/]@?(?:agentic-router|do-it-all-claude-code)[\\/](?:packages[\\/])?(?:daemon|proxy)[\\/](?:src|dist)[\\/]main\.(?:ts|js)\b/i;
/** A process counts as the one its pid file names when it started before the file was written (clock slack). */
const START_SLACK_MS = 2000;

export interface ProcessDeps {
  isAlive(pid: number): boolean;
  /** Command line and start time (ms since the epoch); null when the process cannot be read. */
  info(pid: number): { commandLine: string; startedAt?: number } | null;
  kill(pid: number): void;
  /** POST /router/v1/shutdown to the daemon of `home`, sealed with its token; true when it accepted. */
  shutdownDaemon(home: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  /** How long a stop request may take before the process is forced (tests shorten it). */
  waitMs?: number;
  /** The current install's entries (default: this CLI, its daemon and proxy). */
  entries?: { supervisor: string[]; child: string[] };
}

const readPid = (file: string): number | undefined => {
  try { const n = Number(fs.readFileSync(file, 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : undefined; } catch { return undefined; }
};

function currentEntries(): { supervisor: string[]; child: string[] } {
  const out = { supervisor: [] as string[], child: [] as string[] };
  try { out.supervisor.push(cliEntry()); } catch { /* not resolvable */ }
  try { out.child.push(daemonEntry()); } catch { /* not resolvable */ }
  try {
    const index = fileURLToPath(import.meta.resolve('@do-it-all-claude-code/proxy'));
    out.child.push(path.join(path.dirname(index), index.endsWith('.ts') ? 'main.ts' : 'main.js'));
  } catch { /* not resolvable */ }
  return out;
}

function kindOf(cmd: string, entries: { supervisor: string[]; child: string[] }): 'supervisor' | 'child' | null {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  const c = norm(cmd);
  if (SUPERVISOR_CMD.test(cmd) || (/\bsupervise\b/.test(cmd) && entries.supervisor.some(e => c.includes(norm(e))))) return 'supervisor';
  if (CHILD_CMD.test(cmd) || entries.child.some(e => c.includes(norm(e)))) return 'child';
  return null;
}

async function realShutdown(home: string): Promise<boolean> {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as { daemonPort?: unknown };
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    if (!Number.isInteger(cfg.daemonPort) || !token) return false;
    const r = await sealedCall({ home, port: cfg.daemonPort as number, secret: token, method: 'POST', path: '/router/v1/shutdown', body: '{}', timeoutMs: 3000 });
    return r.status >= 200 && r.status < 300;
  } catch { return false; }
}

export const realProcesses: ProcessDeps = {
  isAlive, info: processInfo, kill: pid => process.kill(pid), shutdownDaemon: realShutdown,
  sleep: ms => new Promise(r => setTimeout(r, ms)),
};

/** A process of the previous release named by one of its pid files; `confirmed` when it may be stopped. */
export interface OldProcess { pid: number; what: string; confirmed: boolean; why?: string }

/**
 * What the previous release runs from `home`: the supervisor of supervise.pid, the children supervise.json
 * recorded, and the daemon of daemon.pid, each only while it is alive and runs a router entry of the matching
 * kind (another program on a reused pid is left out). It is `confirmed` when it started before the file that
 * names it was written; otherwise (it started later, or its start time cannot be read) it is not stopped.
 */
export function oldRouterProcesses(home: string, d: ProcessDeps = realProcesses): OldProcess[] {
  const entries = d.entries ?? currentEntries();
  const files = superviseFiles(home);
  const daemonPidFile = path.join(home, 'daemon.pid');
  const named: Array<{ pid: number; what: string; ref: string; kind: 'supervisor' | 'child' }> = [];
  const sup = readPid(files.pid);
  if (sup !== undefined) named.push({ pid: sup, what: 'supervisor', ref: files.pid, kind: 'supervisor' });
  for (const [name, c] of Object.entries(readSuperviseStatus(home)?.children ?? {})) if (c.pid) named.push({ pid: c.pid, what: name, ref: files.status, kind: 'child' });
  const dp = readPid(daemonPidFile);
  if (dp !== undefined) named.push({ pid: dp, what: 'daemon', ref: daemonPidFile, kind: 'child' });
  const out: OldProcess[] = [];
  for (const n of named) {
    if (out.some(o => o.pid === n.pid) || n.pid === process.pid || !d.isAlive(n.pid)) continue;
    const info = d.info(n.pid);
    if (!info || kindOf(info.commandLine, entries) !== n.kind) continue;
    let written: number | undefined;
    try { written = fs.statSync(n.ref).mtimeMs; } catch { /* gone meanwhile */ }
    const confirmed = info.startedAt !== undefined && written !== undefined && info.startedAt <= written + START_SLACK_MS;
    out.push({ pid: n.pid, what: n.what, confirmed,
      ...(confirmed ? {} : { why: info.startedAt === undefined ? 'its start time cannot be read' : `it started after ${path.basename(n.ref)} was written, so it is not the process that file names` }) });
  }
  return out;
}

const listed = (procs: OldProcess[]) => procs.map(p => `${p.what} pid ${p.pid}`).join(', ');

/**
 * Stops the processes oldRouterProcesses finds (exactly `expected`, when given: what the question listed): the
 * supervisor through its stop file (it stops the proxy, then the daemon), then whatever is left (the daemon
 * gracefully first, then by force).
 */
export async function stopOldRouter(home: string, d: ProcessDeps = realProcesses, expected?: number[]): Promise<{ ok: boolean; detail: string }> {
  const procs = oldRouterProcesses(home, d);
  const unconfirmed = procs.filter(p => !p.confirmed);
  if (unconfirmed.length) return { ok: false, detail: unconfirmed.map(p => `${p.what} pid ${p.pid}: ${p.why}`).join('; ') };
  if (expected && JSON.stringify(procs.map(p => p.pid).sort()) !== JSON.stringify([...expected].sort())) {
    return { ok: false, detail: `what runs changed since the question (now: ${listed(procs) || 'nothing'})` };
  }
  const wait = async (pid: number, ms: number) => { for (let t = 0; t < ms && d.isAlive(pid); t += 100) await d.sleep(100); return !d.isAlive(pid); };
  const forced: number[] = [];
  const force = async (pid: number) => { try { d.kill(pid); forced.push(pid); } catch { /* gone */ } return wait(pid, 5000); };
  const files = superviseFiles(home);
  const sup = procs.find(p => p.what === 'supervisor');
  if (sup) {
    fs.writeFileSync(files.stop, String(process.pid));
    if (!await wait(sup.pid, d.waitMs ?? 50_000)) await force(sup.pid);
    fs.rmSync(files.stop, { force: true });
  }
  for (const p of procs) {
    if (p === sup || !d.isAlive(p.pid)) continue;
    if (p.what === 'daemon' && await d.shutdownDaemon(home) && await wait(p.pid, Math.min(d.waitMs ?? 10_000, 10_000))) continue;
    await force(p.pid);
  }
  const still = oldRouterProcesses(home, d);
  if (still.length) return { ok: false, detail: `${listed(still)} still running` };
  for (const f of [files.pid, path.join(home, 'daemon.pid')]) fs.rmSync(f, { force: true });
  if (!procs.length) return { ok: true, detail: 'the previous release was not running' };
  return { ok: true, detail: `stopped ${procs.map(p => `${p.what} pid ${p.pid}${forced.includes(p.pid) ? ' (forced)' : ''}`).join(', ')}` };
}

// ------------------------------------------------------------------ the folder

/** Moves the home: a rename, or (to another device) a copy and then removing the old folder. */
export function moveHomeFolder(from: string, to: string, rename: (a: string, b: string) => void = fs.renameSync): { how: 'renamed' | 'copied'; leftover?: string } {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try { rename(from, to); return { how: 'renamed' }; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') break;
      // Windows: an indexer or a status line run holding a file open fails the rename for a moment
      if (attempt < 20 && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); continue; }
      throw e;
    }
  }
  try { fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true }); }
  catch (e) { fs.rmSync(to, { recursive: true, force: true }); throw e; }
  try { fs.rmSync(from, { recursive: true }); return { how: 'copied' }; }
  catch (e) { return { how: 'copied', leftover: errText(e) }; }
}

// ------------------------------------------------------------------ the API key

/** The keychain, by service name (tests pass a fake: they never touch a real keychain). */
export interface KeyMover {
  status(service: string): Promise<'present' | VaultErrorCode>;
  read(service: string): Promise<string>;
  store(service: string, key: string): Promise<void>;
  storeInteractive(service: string): Promise<void>;
  remove(service: string): Promise<void>;
}

export const realKeys: KeyMover = {
  status: service => keyStatus({ service }),
  read: service => readKey({ service }),
  store: (service, key) => storeKey({ service, interactive: false, key }),
  storeInteractive: service => storeKey({ service, interactive: true }),
  remove: service => deleteKey({ service }),
};

/** Moves the API key to the new service name; one report line. The key is never printed or kept. */
export async function moveApiKey(k: KeyMover, o: { platform: NodeJS.Platform; isTTY: boolean; out(line: string): void }): Promise<string> {
  const old = await k.status(LEGACY_VAULT_SERVICE);
  if (old === 'not_found') return `API key: none under the previous keychain name "${LEGACY_VAULT_SERVICE}"`;
  if (old !== 'present') return `API key: the previous keychain entry "${LEGACY_VAULT_SERVICE}" could not be checked (${old}); it is left as it is`;
  if (await k.status(VAULT_SERVICE) === 'present') {
    return `API key: the keychain already holds one under "${VAULT_SERVICE}", so the previous entry "${LEGACY_VAULT_SERVICE}" is left; delete it when you no longer need it`;
  }
  try {
    if (o.platform === 'darwin') {
      // security takes a key only from its own prompt (on the command line it would be visible to other processes)
      if (!o.isTTY) return `API key: macOS stores a key only interactively, and this is not a terminal: run ${ROUTER_PLUGIN_NAME} key set, then delete the previous entry "${LEGACY_VAULT_SERVICE}"`;
      o.out(`macOS stores a key only interactively: paste your API key when security asks. The previous entry "${LEGACY_VAULT_SERVICE}" is deleted afterwards.`);
      await k.storeInteractive(VAULT_SERVICE);
    } else {
      await k.store(VAULT_SERVICE, await k.read(LEGACY_VAULT_SERVICE));
    }
  } catch (e) {
    return `API key: not moved (${e instanceof VaultError ? e.code : 'failed'}); the previous entry "${LEGACY_VAULT_SERVICE}" is kept: store the key again with ${ROUTER_PLUGIN_NAME} key set`;
  }
  if (await k.status(VAULT_SERVICE) !== 'present') return `API key: the new entry "${VAULT_SERVICE}" could not be confirmed, so the previous one "${LEGACY_VAULT_SERVICE}" is kept`;
  try { await k.remove(LEGACY_VAULT_SERVICE); }
  catch (e) { return `API key: moved to "${VAULT_SERVICE}", but the previous entry "${LEGACY_VAULT_SERVICE}" could not be deleted (${e instanceof VaultError ? e.code : 'failed'}): delete it yourself`; }
  return `API key: moved to the keychain name "${VAULT_SERVICE}"; the previous entry "${LEGACY_VAULT_SERVICE}" was deleted`;
}

// ------------------------------------------------------------------ init's step

export interface MigrateDeps {
  env: NodeJS.ProcessEnv;
  userHome?: string;
  /** The new home (default: routerHome()). */
  newHome?: string;
  platform?: NodeJS.Platform;
  /** The user the old home must belong to on POSIX (default: this process's; tests pass another). */
  uid?: number;
  settingsFile: string;
  statusLine?: string;
  helpers?: { localToken: string; key: string };
  yes: boolean;
  isTTY: boolean;
  ask(question: string): Promise<boolean>;
  out(line: string): void;
  processes?: ProcessDeps;
  keys: KeyMover;
}

/** 'none': nothing to move; 'moved': init goes on with the new home; 'stop': init must not go on (said why). */
export async function migrateHome(d: MigrateDeps): Promise<'none' | 'moved' | 'stop'> {
  const platform = d.platform ?? process.platform;
  const userHome = d.userHome ?? os.homedir();
  const oldHome = legacyHomeToMove(d.env, userHome);
  const newHome = d.newHome ?? routerHome();
  if (!oldHome || !lstat(oldHome) || samePath(oldHome, newHome, platform)) return 'none';
  const which = d.env.AGENTIC_ROUTER_HOME && path.isAbsolute(d.env.AGENTIC_ROUTER_HOME) ? 'named by AGENTIC_ROUTER_HOME' : 'the previous release\'s folder';
  const source = checkOldHome(oldHome, d.uid ?? process.getuid?.(), platform);
  if (!source.ok) { d.out(`${oldHome} (${which}) is not moved: ${source.why}. Move or remove it yourself, then run init again. Nothing was changed.`); return 'stop'; }
  // the new home must be missing, or an empty real folder (removed just before the move)
  const dest = lstat(newHome);
  if (dest && (dest.isSymbolicLink() || !dest.isDirectory())) {
    d.out(`${newHome} is ${dest.isSymbolicLink() ? 'a link' : 'not a folder'}, and init moves the home only into a new folder: remove it, or set DO_IT_ALL_CLAUDE_CODE_HOME to another place, then run init again. Nothing was changed.`);
    return 'stop';
  }
  if (dest && !emptyDir(newHome)) {
    d.out(`Both ${oldHome} (the previous release, Agentic Router Proxy) and ${newHome} exist. init does not merge them: keep the one you want, move or remove the other, then run init again. Nothing was changed.`);
    return 'stop';
  }
  const processes = d.processes ?? realProcesses;
  const procs = oldRouterProcesses(oldHome, processes);
  const unconfirmed = procs.filter(p => !p.confirmed);
  if (unconfirmed.length) {
    d.out(`The previous release's pid files name ${unconfirmed.map(p => `${p.what} pid ${p.pid} (${p.why})`).join('; ')}. init stops only a process it can confirm: stop it yourself, then run init again. Nothing was changed.`);
    return 'stop';
  }
  const settingsInput: SettingsMoveInput = { oldHome, newHome, platform, userHome, ...(d.statusLine ? { statusLine: d.statusLine } : {}), ...(d.helpers ? { helpers: d.helpers } : {}) };
  const planSettings = () => (fs.existsSync(d.settingsFile) ? moveSettingsEntries(readJsonFile<Record<string, any>>(d.settingsFile, {}), settingsInput) : null);
  let plan: ReturnType<typeof planSettings> = null;
  let unreadable = '';
  try { plan = planSettings(); } catch (e) { unreadable = errText(e); }
  const bakFrom = legacyBackupFile(d.settingsFile);
  const bakTo = backupFile(d.settingsFile);
  const moveBackup = fs.existsSync(bakFrom) && !fs.existsSync(bakTo);
  d.out(`The product was renamed (Agentic Router Proxy is now Do It All Claude Code). init moves ${oldHome} to ${newHome}:`);
  if (d.env.AGENTIC_ROUTER_HOME && !d.env.DO_IT_ALL_CLAUDE_CODE_HOME) d.out('  (AGENTIC_ROUTER_HOME is no longer read: set DO_IT_ALL_CLAUDE_CODE_HOME first to keep the folder somewhere else)');
  d.out(procs.length ? `  - stop the previous release: ${listed(procs)}` : '  - the previous release is not running: nothing to stop');
  d.out('  - move the folder (ledger, tokens, TLS certificate and bundle, config.json, whose paths are rewritten), without its stale endpoint file');
  if (source.looseMode !== undefined) d.out(`  - close it to other users afterwards (it is mode ${octal(source.looseMode)} now)`);
  if (plan) d.out(`  - ${d.settingsFile}: back it up first (without credentials), then:`);
  for (const n of plan?.notes ?? []) d.out(`      ${n}`);
  if (unreadable) d.out(`  - ${d.settingsFile}: left as it is (${unreadable}); fix it and run init again, or edit the router's entries by hand`);
  if (moveBackup) d.out(`  - rename ${bakFrom} to ${path.basename(bakTo)}`);
  d.out(`  - move the API key in the OS keychain from "${LEGACY_VAULT_SERVICE}" to "${VAULT_SERVICE}", if there is one, and delete the previous entry`);
  if (!d.yes) {
    if (!d.isTTY) { d.out('Not a terminal: re-run init with --yes to move it. Nothing was changed.'); return 'stop'; }
    if (!await d.ask('Move it now? [y/N] ')) { d.out(`Nothing was changed. init needs the move first (or remove ${oldHome} to start over).`); return 'stop'; }
  }
  if (dest) {
    try { fs.rmdirSync(newHome); }
    catch (e) { d.out(`${newHome} could not be made room for (${errText(e)}). Nothing was changed.`); return 'stop'; }
  }
  const stopped = await stopOldRouter(oldHome, processes, procs.map(p => p.pid));
  if (!stopped.ok) { d.out(`The previous release did not stop (${stopped.detail}): stop it, then run init again. Nothing was moved.`); return 'stop'; }
  const report = [stopped.detail];
  // decision 156: the endpoint file and socket of the stopped daemon are stale; the new daemon writes its own
  try { const gone = removeEndpointFiles(oldHome); if (gone.length) report.push(`removed the stopped daemon's ${gone.map(f => path.basename(f)).join(', ')}`); }
  catch (e) { report.push(`the stale endpoint file was not removed (${errText(e)})`); }
  let moved: ReturnType<typeof moveHomeFolder>;
  try { moved = moveHomeFolder(oldHome, newHome); }
  catch (e) { d.out(`Could not move ${oldHome} to ${newHome} (${errText(e)}). Nothing was moved; ${stopped.detail}. Run init again.`); return 'stop'; }
  report.push(`moved ${oldHome} to ${newHome} (${moved.how})${moved.leftover ? `; the old folder could not be removed fully (${moved.leftover}): remove it yourself` : ''}`);
  if (source.looseMode !== undefined) {
    try { fs.chmodSync(newHome, 0o700); report.push(`${newHome}: closed to other users (was ${octal(source.looseMode)})`); }
    catch (e) { report.push(`${newHome}: could not be closed to other users (${errText(e)})`); }
  }
  try { const n = rehomeConfig(newHome, oldHome, platform); if (n) report.push(`config.json: ${n} ${n === 1 ? 'value' : 'values'} now under ${newHome}`); }
  catch (e) { report.push(`config.json: not rewritten (${errText(e)}): run init --mode api again if you use API-key mode`); }
  if (!unreadable) {
    try {
      const now = planSettings();       // read again: the file may have changed while the question was open
      if (now) {
        const bak = writeMoveBackup(d.settingsFile);
        writeJsonAtomic(d.settingsFile, now.next);
        report.push(`${d.settingsFile}: ${now.notes.join('; ')}${bak ? ` (as it was before: ${bak})` : ''}`);
      }
    } catch (e) { report.push(`${d.settingsFile}: not rewritten (${errText(e)})`); }
  }
  if (moveBackup) {
    try { fs.renameSync(bakFrom, bakTo); report.push(`settings backup: now ${path.basename(bakTo)}`); }
    catch (e) { report.push(`settings backup: not renamed (${errText(e)})`); }
  }
  report.push(await moveApiKey(d.keys, { platform, isTTY: d.isTTY, out: d.out }));
  d.out('Moved:');
  for (const r of report) d.out(`  - ${r}`);
  d.out('Restart running Claude Code sessions: they still use the previous names.');
  return 'moved';
}

/** doctor: the previous release's home, while it is left. */
export function legacyHomeCheck(env: NodeJS.ProcessEnv = process.env, userHome?: string, newHome: string = routerHome()): Check | null {
  const old = legacyHomeToMove(env, userHome);
  if (!old || !lstat(old) || samePath(old, newHome, process.platform)) return null;
  const source = checkOldHome(old);
  const detail = !source.ok ? `${old} (the previous release's folder) is not one init moves: ${source.why}; move or remove it yourself`
    : lstat(newHome) ? `${old} (the previous release's folder) is still there next to ${newHome}: init does not merge them; remove it once you no longer need it`
    : `${old} (the previous release's folder) is not moved yet: run ${ROUTER_PLUGIN_NAME} init, which moves it`;
  return { name: 'previous home', ok: false, blocking: false, detail };
}
