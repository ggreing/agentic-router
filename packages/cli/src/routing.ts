// Auto-release (decision 138) in the CLI: `agentic-router routing reset`, the doctor lines, and the line init
// prints about the holdout (requests at a delegated level handled lead-direct on purpose, as the baseline).
import { holdoutRate } from '@agentic-router/core';
import type { StatusView } from '@agentic-router/daemon';
import type { Check } from './doctor.ts';
import { localRequest } from './daemonctl.ts';
import type { CliConfig } from './setup.ts';

export const ROUTING_RESET_PATH = '/router/v1/routing/reset';
type Routing = StatusView['routing'];
type Mode = Routing['mode'];

const usd = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(4)}` : '$?');

/** One sentence on the mode and the holdout, for init and doctor. */
export function autoReleaseSummary(mode: Mode, rate: number): string {
  if (mode === 'off') return 'off: delegated levels stay as configured and no request is held out';
  const what = mode === 'on'
    ? 'on: a delegated level whose subagents cost more per accepted task than the lead alone is handled directly (agentic-router routing reset undoes it)'
    : 'observe: the comparison is kept and shown, nothing is switched';
  if (!(rate > 0)) return `${what}; holdout off (set holdoutRate above 0 in config.json for the baseline)`;
  return `${what}; holdout ${Math.round(rate * 100)}% (about 1 in ${Math.round(1 / rate)} requests at a delegated level is handled directly on purpose, as the baseline; set holdoutRate 0 or autoRelease "off" in config.json to stop)`;
}

/** What the daemon will use for a config file (the reader fills in the default holdout when the field is absent). */
export function configuredAutoRelease(cfg: Pick<CliConfig, 'autoRelease' | 'holdoutRate'>): { mode: Mode; rate: number } {
  const mode = cfg.autoRelease ?? 'observe';
  return { mode, rate: mode === 'off' ? 0 : holdoutRate(cfg.holdoutRate) };
}

/** Doctor lines from GET /router/v1/status `routing`: the mode, released levels, and in observe mode what would be. */
export function routingChecks(r: Routing | undefined): Check[] {
  if (!r) return [];
  const out: Check[] = [{ name: 'auto-release', ok: true, blocking: false, detail: autoReleaseSummary(r.mode, r.holdoutRate) }];
  for (const c of r.classes) {
    const released = c.levels.filter(l => l.released).map(l => l.level);
    if (released.length) {
      out.push({ name: `routing: ${c.leadClass} lead`, ok: true, blocking: false,
        detail: `${released.join(', ')} requests are handled directly (released; undo: agentic-router routing reset)` });
    }
    if (r.mode !== 'observe') continue;
    for (const l of c.levels.filter(x => x.candidate && x.decision.action === 'release')) {
      out.push({ name: `routing: ${c.leadClass} lead`, ok: true, blocking: false,
        detail: `${l.level} would be released (delegated ${usd(l.decision.delegatedCost)} vs direct ${usd(l.decision.directCost)} per accepted task); nothing is switched in observe mode` });
    }
  }
  return out;
}

export interface ResetDeps {
  port: number;
  token: string;
  post?: (port: number, token: string) => Promise<{ status: number; body: string } | null>;
  out?: (line: string) => void;
}

/** `agentic-router routing reset`: every released level is delegated again; the request records stay. */
export async function routingReset(d: ResetDeps): Promise<number> {
  const out = d.out ?? (line => console.log(line));
  const r = await (d.post ?? ((port, token) => localRequest(port, 'POST', ROUTING_RESET_PATH, { token, timeoutMs: 3000 })))(d.port, d.token);
  if (!r) { out('The daemon is not running: start it with `agentic-router start` and run this again.'); return 1; }
  if (r.status === 404) { out('This daemon has no auto-release: restart it with `agentic-router stop` and `agentic-router start` after updating.'); return 1; }
  let cleared: number | undefined;
  try { const o = JSON.parse(r.body) as { cleared?: unknown }; if (r.status === 200 && Number.isInteger(o.cleared)) cleared = o.cleared as number; } catch { /* below */ }
  if (cleared === undefined) { out(`Unexpected answer from the daemon (HTTP ${r.status}).`); return 1; }
  // one state row per lead model class (it may hold several released levels)
  out(cleared > 0
    ? `Cleared the auto-release state of ${cleared} lead model class(es): every level is delegated as configured again. The request records are kept.`
    : 'Nothing was released.');
  return 0;
}
