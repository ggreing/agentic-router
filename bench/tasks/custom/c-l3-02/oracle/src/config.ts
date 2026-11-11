import type { ConfigChange, ConfigObject, ConfigSource, ConfigValue } from './types.ts';
import { ConfigError } from './errors.ts';
import { diffConfig } from './diff.ts';
import { parseDuration } from './duration.ts';
import { interpolate } from './interpolate.ts';
import { cloneValue, getPath, leafEntries } from './path.ts';
import { REDACTED, redactConfig, secretMatcher } from './redact.ts';
import { resolveSources } from './resolve.ts';

export interface ConfigOptions {
  /** Layers in priority order: later sources win. */
  sources: ConfigSource[];
  /** Resolve `${path}` references after merging. Defaults to true. */
  interpolate?: boolean;
  /** Path patterns (`*` = one segment) whose values are masked by `explain()` and `toObject({ redact: true })`. */
  secrets?: string[];
}

export interface ExplainEntry {
  path: string;
  value: ConfigValue;
  source: string;
}

export type ChangeListener = (changes: ConfigChange[]) => void;

export interface Config {
  get(path: string): ConfigValue | undefined;
  has(path: string): boolean;
  require(path: string): ConfigValue;
  getString(path: string, fallback?: string): string;
  getNumber(path: string, fallback?: number): number;
  getBoolean(path: string, fallback?: boolean): boolean;
  getDuration(path: string, fallback?: number): number;
  origin(path: string): string | undefined;
  explain(): ExplainEntry[];
  toObject(options?: { redact?: boolean }): ConfigObject;
  reload(): ConfigChange[];
  onChange(listener: ChangeListener): () => void;
}

interface State {
  value: ConfigObject;
  origins: Record<string, string>;
}

export function createConfig(options: ConfigOptions): Config {
  const isSecret = secretMatcher(options.secrets ?? []);
  const listeners = new Set<ChangeListener>();

  const build = (): State => {
    const resolved = resolveSources(options.sources);
    const value = options.interpolate === false ? resolved.value : interpolate(resolved.value);
    return { value, origins: resolved.origins };
  };
  let state = build();

  const missing = (path: string) => new ConfigError('missing required config', { path });

  /** Read `path` through `convert`; a missing value falls back, a value of the wrong kind is an error. */
  function typed<T>(path: string, fallback: T | undefined, kind: string, convert: (value: ConfigValue) => T | undefined): T {
    const value = getPath(state.value, path);
    if (value === undefined) {
      if (fallback !== undefined) return fallback;
      throw missing(path);
    }
    const converted = convert(value);
    if (converted === undefined) throw new ConfigError(`expected ${kind}`, { path });
    return converted;
  }

  return {
    get: (path) => getPath(state.value, path),
    has: (path) => getPath(state.value, path) !== undefined,
    require(path) {
      const value = getPath(state.value, path);
      if (value === undefined) throw missing(path);
      return value;
    },
    getString: (path, fallback) => typed(path, fallback, 'string', (v) => (typeof v === 'string' ? v : undefined)),
    getNumber: (path, fallback) => typed(path, fallback, 'number', (v) => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      return undefined;
    }),
    getBoolean: (path, fallback) => typed(path, fallback, 'boolean', (v) => {
      if (typeof v === 'boolean') return v;
      if (v === 'true') return true;
      if (v === 'false') return false;
      return undefined;
    }),
    getDuration: (path, fallback) => typed(path, fallback, 'duration', (v) => {
      if (typeof v !== 'string' && typeof v !== 'number') return undefined;
      try {
        return parseDuration(v);
      } catch {
        return undefined;
      }
    }),
    origin: (path) => state.origins[path],
    explain: () => leafEntries(state.value)
      .map(([path, value]) => ({
        path,
        value: isSecret(path) ? REDACTED : cloneValue(value),
        source: state.origins[path],
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    toObject: (opts = {}) => (opts.redact ? redactConfig(state.value, isSecret) : cloneValue(state.value)),
    reload() {
      const next = build();   // throws before anything is replaced
      const changes = diffConfig(state.value, next.value);
      state = next;
      if (changes.length > 0) {
        for (const listener of [...listeners]) listener(changes);
      }
      return changes;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
