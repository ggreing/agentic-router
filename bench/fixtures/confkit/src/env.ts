import type { ConfigObject } from './types.ts';
import { setPath } from './path.ts';

/**
 * Build a config layer from environment variables that start with `prefix`.
 * Names are lower-cased and `__` separates nesting levels; values stay strings.
 *
 *   fromEnv({ APP_DB__HOST: 'db', APP_PORT: '80' }, 'APP_') // { db: { host: 'db' }, port: '80' }
 */
export function fromEnv(env: Record<string, string | undefined>, prefix: string): ConfigObject {
  const result: ConfigObject = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !name.startsWith(prefix)) continue;
    const segments = name.slice(prefix.length).toLowerCase().split('__').filter((s) => s !== '');
    if (segments.length === 0) continue;
    setPath(result, segments, value);
  }
  return result;
}
