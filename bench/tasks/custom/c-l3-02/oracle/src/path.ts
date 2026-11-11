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

/**
 * Every leaf of a config as [dotted path, value], in key order. A leaf is any value that is not a
 * plain object (arrays and null are leaves); empty objects contribute nothing.
 */
export function leafEntries(config: ConfigObject, prefix = ''): Array<[string, ConfigValue]> {
  const out: Array<[string, ConfigValue]> = [];
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(value)) out.push(...leafEntries(value, path));
    else out.push([path, value]);
  }
  return out;
}

/** Deep copy of a config value (objects and arrays are copied, primitives returned as is). */
export function cloneValue<T extends ConfigValue | undefined>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (isPlainObject(value)) {
    const copy: ConfigObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) copy[key] = cloneValue(item);
    }
    return copy as T;
  }
  return value;
}
