import { ConfigError } from './errors.ts';

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;

/**
 * Parse a human duration into milliseconds: '500ms', '10s', '1m30s', '2d'.
 * A number is taken to already be milliseconds.
 */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new ConfigError(`invalid duration: ${input}`);
    return input;
  }
  const text = input.trim();
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(PART)) {
    if (match.index !== consumed) break;
    total += Number(match[1]) * UNIT_MS[match[2]];
    consumed += match[0].length;
  }
  if (text === '' || consumed !== text.length) {
    throw new ConfigError(`invalid duration: "${input}"`);
  }
  return Math.round(total);
}
