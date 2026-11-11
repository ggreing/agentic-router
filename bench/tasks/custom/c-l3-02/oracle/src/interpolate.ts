import type { ConfigObject, ConfigValue } from './types.ts';
import { ConfigError } from './errors.ts';
import { getPath, isPlainObject } from './path.ts';

const TOKEN = /\$\$\{|\$\{([^}]*)\}/g;
const WHOLE = /^\$\{([^}]*)\}$/;

/**
 * Replace `${dotted.path}` references in string values with the value at that path.
 * A string that is exactly one reference takes the referenced value with its type; otherwise the
 * values are written into the string. `$${` is a literal `${`. References may point at values that
 * contain references themselves; a cycle or an unknown path is a ConfigError. Returns a new object.
 */
export function interpolate(config: ConfigObject): ConfigObject {
  const expand = (text: string, path: string, chain: readonly string[]): ConfigValue => {
    const whole = WHOLE.exec(text);
    if (whole) return lookup(whole[1].trim(), path, chain);
    return text.replace(TOKEN, (match, ref: string | undefined) =>
      ref === undefined ? '${' : String(lookup(ref.trim(), path, chain)));
  };

  const lookup = (ref: string, path: string, chain: readonly string[]): string | number | boolean => {
    if (chain.includes(ref)) {
      throw new ConfigError(`circular reference: ${[...chain, ref].join(' -> ')}`, { path });
    }
    const raw = ref === '' ? undefined : getPath(config, ref);
    if (raw === undefined) throw new ConfigError(`unknown reference "\${${ref}}"`, { path });
    const value = typeof raw === 'string' ? expand(raw, path, [...chain, ref]) : raw;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new ConfigError(`reference "\${${ref}}" is not a string, number or boolean`, { path });
    }
    return value;
  };

  const walk = (value: ConfigValue, path: string): ConfigValue => {
    if (typeof value === 'string') return expand(value, path, [path]);
    if (Array.isArray(value)) return value.map((item) => walk(item, path));
    if (isPlainObject(value)) return walkObject(value, path);
    return value;
  };

  const walkObject = (object: ConfigObject, prefix: string): ConfigObject => {
    const out: ConfigObject = {};
    for (const [key, value] of Object.entries(object)) {
      if (value === undefined) continue;
      out[key] = walk(value, prefix === '' ? key : `${prefix}.${key}`);
    }
    return out;
  };

  return walkObject(config, '');
}
