// Who holds the proxy port when what answers there does not prove it is this router's proxy (decision 156). A proof
// can fail for harmless reasons: a timeout, a proxy of an older version without the proof route, one restarting after
// a TLS switch. So doctor names the holder: the user's own node process is most likely such a proxy (a warning); a
// process of another user, or one that cannot be identified, is treated as a squatter (blocking). A hint only: the
// lookup (core's port-owner probe) can find nothing, and the listener can change after it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { portOwnerInfo, type PortOwner } from './portowner.ts';

/** The executable name of a process, or undefined. */
export function processName(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  try {
    if (platform === 'linux') return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || undefined;
    if (platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      return /^"([^"]+)"/.exec((r.stdout ?? '').trim())?.[1];
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 });
    return (r.stdout ?? '').trim() || undefined;
  } catch { return undefined; }
}

export interface ProxyHolder { own: boolean; phrase: string }

/**
 * Classifies a holder (pure, for tests). `own` is decided by the listener's user, which the kernel reports (on Linux
 * a uid without a pid); the process name, when there is one, only goes into the wording.
 */
export function classifyHolder(o: PortOwner | undefined, name: string | undefined): ProxyHolder {
  if (!o) return { own: false, phrase: 'a process that could not be identified' };
  const who = o.user ? `user ${o.user}` : o.uid !== undefined ? `uid ${o.uid}` : '';
  const details = [o.pid !== undefined ? `pid ${o.pid}` : '', who].filter(Boolean).join(', ');
  const what = `${name ? path.basename(name) : 'process'}${details ? ` (${details})` : ''}`;
  if (o.mine === true) return { own: true, phrase: `your own ${what}` };
  return { own: false, phrase: o.mine === false ? `ANOTHER user's ${what}` : `a ${what}` };
}

export async function proxyHolder(port: number): Promise<ProxyHolder> {
  const o = await portOwnerInfo(port);
  return classifyHolder(o, o?.pid !== undefined ? processName(o.pid) : undefined);
}
