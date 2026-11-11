import type { ConfigObject, ConfigSource } from './types.ts';
import { ConfigError } from './errors.ts';
import { cloneValue, isPlainObject, leafEntries } from './path.ts';

export interface Resolved {
  /** The merged configuration (later sources win; objects merge key by key, everything else is replaced). */
  value: ConfigObject;
  /** For every leaf path of `value`, the name of the source its value came from. */
  origins: Record<string, string>;
}

/** Load every source in order and merge them, remembering which source supplied each leaf. */
export function resolveSources(sources: readonly ConfigSource[]): Resolved {
  const names = new Set<string>();
  for (const source of sources) {
    if (names.has(source.name)) throw new ConfigError(`duplicate source name: ${source.name}`);
    names.add(source.name);
  }
  const value: ConfigObject = {};
  const origins: Record<string, string> = {};
  for (const source of sources) mergeInto(value, source.load(), '', source.name, origins);
  return { value, origins };
}

function mergeInto(target: ConfigObject, layer: ConfigObject, prefix: string, name: string, origins: Record<string, string>): void {
  for (const [key, incoming] of Object.entries(layer)) {
    if (incoming === undefined) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(incoming)) {
      mergeInto(existing, incoming, path, name, origins);
      continue;
    }
    // replaced as a whole: whatever was recorded at or below this path is gone
    for (const known of Object.keys(origins)) {
      if (known === path || known.startsWith(`${path}.`)) delete origins[known];
    }
    target[key] = cloneValue(incoming);
    if (isPlainObject(incoming)) {
      for (const [leaf] of leafEntries(incoming, path)) origins[leaf] = name;
    } else {
      origins[path] = name;
    }
  }
}
