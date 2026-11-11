import { isDeepStrictEqual } from 'node:util';
import type { ConfigChange, ConfigObject } from './types.ts';
import { leafEntries } from './path.ts';

/** Leaves that were added, removed or changed between two configurations, sorted by path. */
export function diffConfig(before: ConfigObject, after: ConfigObject): ConfigChange[] {
  const old = new Map(leafEntries(before));
  const next = new Map(leafEntries(after));
  const changes: ConfigChange[] = [];
  for (const path of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(path);
    const b = next.get(path);
    if (!isDeepStrictEqual(a, b)) changes.push({ path, before: a, after: b });
  }
  return changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}
