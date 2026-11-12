// `agentic-router dashboard` (decision 132): asks the daemon for a one-time login code with the local Bearer
// token (POST /dashboard/register-code) and opens http://127.0.0.1:<port>/dashboard#code=<code> in the
// browser; the page trades the code for a session cookie. The token stays in this process: it is sent only
// in the Authorization header to 127.0.0.1, never put in a URL, an argument or a log line. The code is
// single-use and expires in a minute, so the URL is printed when no browser can be opened. The browser is
// pointed at a local page holding the URL (audit C1), so the code never shows in a process list.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths, routerHome } from '@agentic-router/core';
import { localRequest } from './daemonctl.ts';
import { readConfig } from './setup.ts';

export const REGISTER_PATH = '/dashboard/register-code';
const URL_ENV = 'AGENTIC_ROUTER_DASHBOARD_URL';

export type Opener = (url: string) => Promise<boolean>;

/**
 * How to hand a file or URL to the default browser. No shell parses it: on Windows it goes to Start-Process
 * through an environment variable (cmd's `start` would read `&` and `^`); elsewhere it is a single argument.
 */
export function browserCommand(target: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[]; env?: Record<string, string> } {
  if (platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath $env:${URL_ENV}`], env: { [URL_ENV]: target } };
  }
  if (platform === 'darwin') return { command: 'open', args: [target] };
  return { command: 'xdg-open', args: [target] };
}

/** The page the browser is pointed at: it holds the URL with the code, so the code is in no process's arguments. */
export const launchPage = (home: string = routerHome()): string => path.join(home, 'dashboard-open.html');

/**
 * Audit C1: writes a page (0600, in the router home) that sends the browser on to `url`, and returns its path.
 * The opener gets only the path; process lists show no code. The code is single-use and expires in a minute;
 * the page is replaced or removed by the next `agentic-router dashboard`.
 */
export function writeLaunchPage(url: string, home: string = routerHome()): string {
  const file = launchPage(home);
  fs.rmSync(file, { force: true });
  const u = JSON.stringify(url).replace(/</g, '\\u003c');
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>agentic-router dashboard</title>
<script>location.replace(${u})</script><p>Opening the dashboard…</p>\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return file;
}

/** Opens a URL in the default browser by way of the launch page; false when the opener is missing, fails or hangs. */
export const openBrowser: Opener = url => new Promise(resolve => {
  let page: string;
  try { page = writeLaunchPage(url); } catch { resolve(false); return; }
  const c = browserCommand(page);
  let done = false;
  const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
  try {
    const child = spawn(c.command, c.args, { stdio: 'ignore', windowsHide: true, env: { ...process.env, ...(c.env ?? {}) } });
    child.on('error', () => finish(false));
    child.on('exit', code => finish(code === 0));
    setTimeout(() => { finish(false); child.unref(); }, 15_000).unref();
  } catch { finish(false); }
});

export interface DashboardDeps {
  port: number;
  token: string;
  register?: (port: number, token: string) => Promise<{ status: number; body: string } | null>;
  open?: Opener;
  out?: (line: string) => void;
  noOpen?: boolean;
}

const defaultRegister = (port: number, token: string) => localRequest(port, 'POST', REGISTER_PATH, { token, timeoutMs: 3000 });

/** Exit code 0 when the dashboard was opened or its URL printed. */
export async function openDashboard(d: DashboardDeps): Promise<number> {
  const out = d.out ?? (line => console.log(line));
  const r = await (d.register ?? defaultRegister)(d.port, d.token);
  if (!r) { out('The daemon is not running: start it with `agentic-router start`.'); return 1; }
  if (r.status === 401) { out('The daemon refused the local token (it was started with another one): run `agentic-router stop` and `agentic-router start`.'); return 1; }
  if (r.status === 404) { out('This daemon has no dashboard: restart it with `agentic-router stop` and `agentic-router start` after updating.'); return 1; }
  let url = '';
  try {
    const o = JSON.parse(r.body) as { code?: unknown; url?: unknown };
    if (r.status === 200 && typeof o.code === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(o.code) && o.url === `http://127.0.0.1:${d.port}/dashboard#code=${o.code}`) url = o.url;
  } catch { /* handled below */ }
  if (!url) { out(`Unexpected answer from the daemon (HTTP ${r.status}).`); return 1; }
  const page = `http://127.0.0.1:${d.port}/dashboard`;
  if (!d.noOpen && await (d.open ?? openBrowser)(url)) {
    out(`Opened the dashboard in your browser: ${page}`);
    return 0;
  }
  out(`${d.noOpen ? 'Open' : 'Could not open a browser. Open'} this address within a minute (it works once; run \`agentic-router dashboard\` again for a new one):`);
  out(`  ${url}`);
  return 0;
}

/** The CLI command: config and token from the router home. */
export async function dashboardCommand(f: Record<string, string | boolean>): Promise<number> {
  const cfg = readConfig();
  let token = '';
  try { token = fs.readFileSync(paths.token(), 'utf8').trim(); } catch { /* below */ }
  if (!cfg || !token) { console.log('Not set up yet: run `agentic-router init` first.'); return 2; }
  return openDashboard({ port: cfg.daemonPort, token, noOpen: f['no-open'] === true });
}
