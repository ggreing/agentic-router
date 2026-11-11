// Append-only spend ledger. The total cap in config/budget.json is enforced against it
// before every run, so an interrupted session can resume without overspending.
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS } from './util.ts';

const LEDGER = path.join(RESULTS, 'ledger.jsonl');

export function spent(): number {
  if (!fs.existsSync(LEDGER)) return 0;
  return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
    .reduce((a, l) => a + (JSON.parse(l).costUsd || 0), 0);
}

export function record(runId: string, costUsd: number): void {
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify({ t: new Date().toISOString(), runId, costUsd }) + '\n');
}
