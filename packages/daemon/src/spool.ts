// Replays hook events that relay.mjs queued while the daemon was down (spool/*.jsonl).
// Line format: {"receivedAt": ISO-8601, "input": <hook input>};
// a bare hook input per line is accepted too. Files are replayed in name order, each renamed to
// `.replaying` first (so a relay writing at the same time starts a new file) and deleted when done.
// Replayed events are recorded only: the router does not verify, block or inject for them.
// Decision 100: an event older than 24 hours (its receivedAt, else the file's time) is dropped, not
// replayed; the count is logged.
import fs from 'node:fs';
import path from 'node:path';
import type { ClientAdapter } from './adapter.ts';
import { errorText, type Logger } from './log.ts';
import type { Router } from './router.ts';

export interface ReplayResult { files: number; events: number; errors: number; dropped: number }

export const MAX_REPLAY_AGE_MS = 24 * 60 * 60 * 1000;

const REPLAYING = '.replaying';

/** Rounds of replay: hooks keep spooling while the daemon starts, so the folder is read until it is empty. */
export const MAX_REPLAY_ROUNDS = 10;

export async function replaySpool(
  dir: string, adapter: ClientAdapter, router: Router, log: Logger, now: () => Date = () => new Date(),
): Promise<ReplayResult> {
  const res: ReplayResult = { files: 0, events: 0, errors: 0, dropped: 0 };
  for (let round = 0; round < MAX_REPLAY_ROUNDS; round++) {
    const before = res.files;
    await replayRound(dir, adapter, router, log, res, now);
    if (res.files === before) break;   // audit #12: nothing new appeared during the last round
  }
  if (res.dropped) log.warn('spooled events older than 24 h dropped, not replayed', { dropped: res.dropped });
  if (res.files) log.info('spool replayed', { ...res });
  return res;
}

async function replayRound(dir: string, adapter: ClientAdapter, router: Router, log: Logger, res: ReplayResult, now: () => Date): Promise<void> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  // Leftovers of an interrupted replay first, then new files; each group in name order.
  const leftovers = names.filter(f => f.endsWith(`.jsonl${REPLAYING}`)).sort();
  const fresh = names.filter(f => f.endsWith('.jsonl')).sort();
  for (const name of [...leftovers, ...fresh]) {
    const src = path.join(dir, name);
    const work = name.endsWith(REPLAYING) ? src : `${src}${REPLAYING}`;
    try {
      if (work !== src) fs.renameSync(src, work);
    } catch (e) {
      log.warn('spool file skipped', { file: name, error: errorText(e) });
      continue;
    }
    res.files++;
    let fileTime = now().getTime();
    try { fileTime = fs.statSync(work).mtimeMs; } catch { /* keep now */ }
    const lines = fs.readFileSync(work, 'utf8').split(/\r?\n/);
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        const { input, receivedAt } = parseLine(line);
        const at = receivedAt ? Date.parse(receivedAt) : NaN;
        if (now().getTime() - (Number.isFinite(at) ? at : fileTime) > MAX_REPLAY_AGE_MS) { res.dropped++; continue; }
        const ev = adapter.toRouterEvent(input, { spooled: true, ...(receivedAt ? { receivedAt } : {}) });
        ev.spooled = true;
        if (receivedAt) ev.receivedAt = receivedAt;
        await router.process(ev);
        res.events++;
      } catch (e) {
        res.errors++;
        log.warn('spool line skipped', { file: name, line: i + 1, error: errorText(e) });
      }
    }
    try {
      fs.unlinkSync(work);
    } catch (e) {
      log.warn('spool file not removed', { file: name, error: errorText(e) });
    }
  }
}

function parseLine(line: string): { input: Record<string, unknown>; receivedAt?: string } {
  const v: unknown = JSON.parse(line);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('spool line is not an object');
  const o = v as Record<string, unknown>;
  if (o.input && typeof o.input === 'object' && !Array.isArray(o.input) && o.hook_event_name === undefined) {
    const at = typeof o.receivedAt === 'string' ? o.receivedAt : typeof o.t === 'number' ? new Date(o.t).toISOString() : undefined;
    return { input: o.input as Record<string, unknown>, ...(at ? { receivedAt: at } : {}) };
  }
  return { input: o };
}
