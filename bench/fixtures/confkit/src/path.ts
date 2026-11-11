import type { ConfigObject, ConfigValue } from './types.ts';
import { ConfigError } from './errors.ts';

export function isPlainObject(value: unknown): value is ConfigObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Read a dotted path such as "db.replica.host"; undefined when any segment is missing. */
export function getPath(config: ConfigObject, path: string): ConfigValue | undefined {
  let current: ConfigValue | undefined = config;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Write `value` at `segments`, creating intermediate objects as needed. */
export function setPath(target: ConfigObject, segments: string[], value: ConfigValue): void {
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next === undefined) {
      const created: ConfigObject = {};
      current[segment] = created;
      current = created;
    } else if (isPlainObject(next)) {
      current = next;
    } else {
      throw new ConfigError('cannot nest a value under a non-object', { path: segments.join('.') });
    }
  }
  current[segments[segments.length - 1]] = value;
}
