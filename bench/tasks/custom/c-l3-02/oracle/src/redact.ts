import type { ConfigObject, ConfigValue } from './types.ts';
import { isPlainObject } from './path.ts';

export const REDACTED = '***';

/**
 * Build a test for "is this path secret". A pattern is a dotted path in which `*` stands for exactly
 * one segment (`db.password`, `*.token`, `api.*`). A path is secret when a pattern matches it or one
 * of its parents (so everything below a secret object is secret too).
 */
export function secretMatcher(patterns: readonly string[]): (path: string) => boolean {
  const compiled = patterns.map((pattern) => pattern.split('.'));
  return (path) => {
    const segments = path.split('.');
    return compiled.some((pattern) =>
      pattern.length <= segments.length && pattern.every((part, i) => part === '*' || part === segments[i]));
  };
}

/** Copy of `config` with every secret value replaced by "***" (a secret object is replaced as a whole). */
export function redactConfig(config: ConfigObject, isSecret: (path: string) => boolean, prefix = ''): ConfigObject {
  const out: ConfigObject = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    out[key] = isSecret(path) ? REDACTED : isPlainObject(value) ? redactConfig(value, isSecret, path) : copy(value);
  }
  return out;
}

function copy(value: ConfigValue): ConfigValue {
  return Array.isArray(value) ? value.map(copy) : isPlainObject(value) ? redactConfig(value, () => false) : value;
}
