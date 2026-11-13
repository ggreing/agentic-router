// `do-it-all-claude-code data export` and `data purge` (spec 3.7, 4.4). With the daemon running they go through its
// routes (it owns the ledger); with no daemon the CLI opens the ledger itself and runs the same code
// (@do-it-all-claude-code/daemon data.ts, loaded only here so other commands do not load the daemon). A purge is never
// run beside a daemon that is alive but not answering.

const lib = () => import('@do-it-all-claude-code/daemon');
import fs from 'node:fs';
import path from 'node:path';
import { paths, routerHome } from '@do-it-all-claude-code/core';
import type { Ledger, PurgeResult } from '@do-it-all-claude-code/daemon';
import { daemonIdentity, daemonProcessAlive, daemonRequest } from './daemonctl.ts';
import { removeEndpointFiles } from './endpointfiles.ts';
import { readConfig } from './setup.ts';

export const EXPORT_PATH = '/router/v1/data/export';
export const PURGE_PATH = '/router/v1/data/purge';

type Flags = Record<string, string | boolean>;
type Answer = { status: number; body: string } | null;

export interface DataDeps {
  /** The daemon, when one answers: a request with the local token. */
  daemon(): Promise<{ get(p: string): Promise<Answer>; post(p: string, body: unknown): Promise<Answer> } | null>;
  /** True when a daemon process is alive but does not answer (then nothing writes the ledger beside it). */
  daemonStuck(): boolean;
  /** The ledger opened by the CLI, with what export needs from the config and the token files. */
  openLedger(): Promise<{ ledger: Ledger; recordPrompts: boolean; secrets: string[] }>;
  out(line: string): void;
  /** Notes when the export goes to stdout. */
  err(line: string): void;
  writeStdout(text: string): void;
  confirm(question: string): Promise<boolean>;
  isTTY: boolean;
}

const read = (f: string) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };

export function realDataDeps(o: { confirm(q: string): Promise<boolean>; isTTY: boolean }): DataDeps {
  return {
    async daemon() {
      const cfg = readConfig();
      const token = read(paths.token());
      if (!cfg || !token || (await daemonIdentity(cfg.daemonPort, token)).who !== 'ours') return null;   // decision 156: only the daemon that holds the token
      return {
        get: p => daemonRequest(cfg.daemonPort, 'GET', p, { token, timeoutMs: 60_000 }),
        post: (p, body) => daemonRequest(cfg.daemonPort, 'POST', p, { token, body: JSON.stringify(body), timeoutMs: 120_000 }),
      };
    },
    daemonStuck: () => daemonProcessAlive(),
    openLedger: async () => {
      const recordPrompts = readConfig()?.recordPrompts === true;
      return {
      ledger: new (await lib()).Ledger(paths.db(), { keepPrompts: recordPrompts }),   // decision 141
      recordPrompts,
      secrets: [read(paths.token()), read(path.join(routerHome(), 'proxy-token'))].filter(Boolean),
      };
    },
    out: line => console.log(line),
    err: line => console.error(line),
    writeStdout: text => process.stdout.write(text),
    confirm: o.confirm,
    isTTY: o.isTTY,
  };
}

async function dateFlag(f: Flags, name: string, d: DataDeps): Promise<{ ok: true; value?: string } | { ok: false }> {
  const raw = f[name];
  if (raw === undefined) return { ok: true };
  const v = typeof raw === 'string' ? (await lib()).isoTime(raw) : undefined;
  if (!v) { d.out(`--${name} takes a date such as 2026-10-01 or 2026-10-01T09:00:00Z`); return { ok: false }; }
  return { ok: true, value: v };
}

/** `data export [--out <file>] [--since <date>] [--until <date>]`: JSON lines to the file (0600) or stdout. */
export async function dataExport(f: Flags, d: DataDeps): Promise<number> {
  const since = await dateFlag(f, 'since', d), until = await dateFlag(f, 'until', d);
  if (!since.ok || !until.ok) return 2;
  if (f.out === true) { d.out('--out takes a file name'); return 2; }
  let text: string;
  const api = await d.daemon();
  if (api) {
    const q = new URLSearchParams({ ...(since.value ? { since: since.value } : {}), ...(until.value ? { until: until.value } : {}) }).toString();
    const r = await api.get(`${EXPORT_PATH}${q ? `?${q}` : ''}`);
    if (!r || r.status !== 200) { d.out(r?.status === 404 ? 'This daemon has no data export: restart it with `do-it-all-claude-code stop` and `do-it-all-claude-code start` after updating.' : `The daemon could not export (HTTP ${r?.status ?? 'no answer'}).`); return 1; }
    text = r.body;
  } else {
    const o = await d.openLedger();
    const { exportLines } = await lib();
    try {
      text = `${[...exportLines(o.ledger.db, { ...(since.value ? { since: since.value } : {}), ...(until.value ? { until: until.value } : {}), includePrompts: o.recordPrompts, secrets: o.secrets })].join('\n')}\n`;
    } finally { o.ledger.close(); }
  }
  const n = Math.max(0, text.trim().split('\n').length - 1);
  if (typeof f.out === 'string') {
    const file = path.resolve(f.out);
    fs.writeFileSync(file, text, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    d.out(`Exported ${n} request(s) to ${file}.`);
  } else {
    d.writeStdout(text);
    d.err(`Exported ${n} request(s).`);
  }
  return 0;
}

function describe(r: PurgeResult, scope: string): string {
  const rows = Object.values(r.rows).reduce((a, b) => a + b, 0);
  const f = r.files ?? {};
  const files = Object.entries(f).filter(([k]) => k !== 'logs' && k !== 'endpoint').reduce((a, [, n]) => a + n, 0);
  const parts = [`${r.requests} closed request(s) ${scope}`];
  if (rows) parts.push(`${rows} row(s) in all (subtasks, events, signals, costs, proxy rows, session records)`);
  if (files) parts.push(`${files} file(s) (spool, scope and agent files)`);
  if (f.endpoint) parts.push(`the stopped daemon's endpoint file and socket (${f.endpoint})`);
  if (f.logs) parts.push(`${f.logs} log file(s) emptied`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]!;
}

/** `data purge (--before <date> | --all) [--yes]`: counts first, asks, then removes and compacts. */
export async function dataPurge(f: Flags, d: DataDeps): Promise<number> {
  const before = await dateFlag(f, 'before', d);
  if (!before.ok) return 2;
  const all = f.all === true;
  if (all === !!before.value) { d.out('usage: do-it-all-claude-code data purge --before <date> | --all [--yes]'); return 2; }
  const scope = all ? '(all of them)' : `closed before ${before.value}`;
  const body = all ? { all: true } : { before: before.value };
  const api = await d.daemon();
  if (!api && d.daemonStuck()) { d.out('The daemon is running but not answering: stop it with `do-it-all-claude-code stop` first.'); return 1; }
  const run = async (dryRun: boolean): Promise<PurgeResult | null> => {
    if (api) {
      const r = await api.post(PURGE_PATH, { ...body, dryRun });
      if (!r || r.status !== 200) { d.out(r?.status === 404 ? 'This daemon has no data purge: restart it after updating.' : `The daemon could not purge (HTTP ${r?.status ?? 'no answer'}).`); return null; }
      return JSON.parse(r.body) as PurgeResult;
    }
    const o = await d.openLedger();
    const { liveSessions, purge, purgeFiles } = await lib();
    try {
      const r = purge(o.ledger.db, { ...(all ? { all } : { before: before.value! }), dryRun });
      if (all) {
        r.files = purgeFiles({ spoolDir: paths.spoolDir(), scopesDir: paths.scopesDir(), agentsDir: paths.agentsDir(), logsDir: paths.logsDir(), root: routerHome() }, liveSessions(o.ledger.db), dryRun);
        // decision 156: the daemon is not running here, so its endpoint file and socket (and a fallback socket
        // directory that is ours) go too; a running daemon keeps its own, and rewrites them at its next start
        const ends = removeEndpointFiles(routerHome(), { dryRun });
        if (ends.length) r.files.endpoint = ends.length;
      }
      return r;
    } finally { o.ledger.close(); }
  };
  const plan = await run(true);
  if (!plan) return 1;
  const kept = plan.keptOpen ? ` ${plan.keptOpen} open or waiting request(s) and everything of their sessions are kept.` : '';
  if (!Object.keys(plan.rows).length && !Object.keys(plan.files ?? {}).length) { d.out(`Nothing to remove.${kept}`); return 0; }
  d.out(`This removes ${describe(plan, scope)}.${kept} It cannot be undone; \`do-it-all-claude-code data export\` first keeps a copy.`);
  if (f.yes !== true) {
    if (!d.isTTY) { d.out('Not a terminal: re-run with --yes to purge.'); return 1; }
    if (!await d.confirm('Purge? [y/N] ')) { d.out('Nothing removed.'); return 1; }
  }
  const done = await run(false);
  if (!done) return 1;
  d.out(`Removed ${describe(done, scope)}${done.compacted ? '; the ledger was compacted' : ''}.`);
  return 0;
}
