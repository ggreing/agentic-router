// Who is listening on a local port (decision 156, option c): a HINT for messages in `start` and `doctor`,
// never a check. It can take a second on Windows, it can be wrong a moment later, and it needs tools that
// are not always there; what protects the token is that the router's clients seal their messages
// (core seal.ts), whoever holds the port.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    } catch { resolve(''); }
  });
}

export interface PortOwner { pid?: number; user?: string; uid?: number; mine?: boolean }

/** Pure parsers, exported for tests. */
export function parseProcNetTcp(text: string, port: number): { uid: number } | undefined {
  // sl local_address rem_address st … uid …   (st 0A = LISTEN; the address is hex, the port after the colon)
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || f[3] !== '0A') continue;
    const p = parseInt((f[1] ?? '').split(':')[1] ?? '', 16);
    if (p === port && /^\d+$/.test(f[7] ?? '')) return { uid: Number(f[7]) };
  }
  return undefined;
}
export function parseNetstat(text: string, port: number): number | undefined {
  // "  TCP    127.0.0.1:47800        0.0.0.0:0              LISTENING       1234"
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] === 'TCP' && f[3] === 'LISTENING' && new RegExp(`^(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1?\\]):${port}$`).test(f[1] ?? '') && /^\d+$/.test(f[4] ?? '')) return Number(f[4]);
  }
  return undefined;
}
export function parseTasklistUser(csv: string): string | undefined {
  // "Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"
  const row = csv.split(/\r?\n/).filter(l => l.startsWith('"'))[1];
  const cells = row?.match(/"([^"]*)"/g)?.map(c => c.slice(1, -1));
  const user = cells?.[6];
  return user && user !== 'N/A' ? user : undefined;
}
export function parseLsof(text: string): { pid: number; user: string } | undefined {
  // COMMAND   PID USER   FD   TYPE …
  const f = text.split('\n')[1]?.trim().split(/\s+/);
  return f && /^\d+$/.test(f[1] ?? '') && f[2] ? { pid: Number(f[1]), user: f[2] } : undefined;
}

/** The process and user that listen on 127.0.0.1:<port>, as far as this system tells without extra tools. */
export async function portOwnerInfo(port: number, platform: NodeJS.Platform = process.platform): Promise<PortOwner | undefined> {
  try {
    if (platform === 'linux') {
      const hit = parseProcNetTcp(fs.readFileSync('/proc/net/tcp', 'utf8'), port);
      if (hit) return { uid: hit.uid, mine: hit.uid === process.getuid?.() };
    }
    if (platform === 'win32') {
      const pid = parseNetstat(await run('netstat', ['-ano', '-p', 'TCP'], 5000), port);
      if (pid === undefined) return undefined;
      const user = parseTasklistUser(await run('tasklist', ['/FI', `PID eq ${pid}`, '/V', '/FO', 'CSV'], 8000));
      const me = os.userInfo().username.toLowerCase();
      return { pid, ...(user ? { user, mine: user.toLowerCase().split('\\').pop() === me } : {}) };
    }
    const l = parseLsof(await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], 5000));
    if (l) return { pid: l.pid, user: l.user, mine: l.user === os.userInfo().username };
  } catch { /* a hint only */ }
  return undefined;
}

/** One phrase for a message, or '' when nothing could be found out. */
export async function portOwner(port: number): Promise<string> {
  const o = await portOwnerInfo(port);
  if (!o) return '';
  const who = o.user ? `user ${o.user}` : o.uid !== undefined ? `uid ${o.uid}` : '';
  const whose = o.mine === true ? 'your own' : o.mine === false ? 'ANOTHER user\'s' : 'a';
  return [`${whose} process`, o.pid !== undefined ? `pid ${o.pid}` : '', who].filter(Boolean).join(', ');
}
