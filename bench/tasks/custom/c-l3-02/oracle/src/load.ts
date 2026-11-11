import type { ConfigObject, ConfigSource } from './types.ts';
import { createConfig } from './config.ts';
import { argvSource, envSource, iniSource, objectSource } from './sources/index.ts';

export interface LoadOptions {
  defaults?: ConfigObject;
  /** INI documents, applied in order (later wins). */
  sources?: string[];
  env?: Record<string, string | undefined>;
  /** Only env vars with this prefix are used. Defaults to "APP_". */
  envPrefix?: string;
  /** Command-line options (`--db.host=x`); they win over everything else. */
  argv?: string[];
  /** Resolve `${path}` references in the merged result. Defaults to false. */
  interpolate?: boolean;
}

/** The layers of `loadConfig` as named sources: `defaults`, `ini:0`, `ini:1`, ..., `env`, `argv`. */
export function sourcesFor(options: LoadOptions): ConfigSource[] {
  const sources: ConfigSource[] = [];
  if (options.defaults) sources.push(objectSource('defaults', options.defaults));
  (options.sources ?? []).forEach((text, i) => sources.push(iniSource(`ini:${i}`, text)));
  if (options.env) sources.push(envSource(options.env, options.envPrefix ?? 'APP_'));
  if (options.argv) sources.push(argvSource(options.argv));
  return sources;
}

/** Merge defaults, INI sources, environment variables and command-line options into one config object. */
export function loadConfig(options: LoadOptions = {}): ConfigObject {
  return createConfig({ sources: sourcesFor(options), interpolate: options.interpolate ?? false }).toObject();
}
