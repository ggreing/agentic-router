import type { ConfigObject } from './types.ts';
import { parseIni } from './parse.ts';
import { fromEnv } from './env.ts';
import { deepMerge } from './merge.ts';

export interface LoadOptions {
  defaults?: ConfigObject;
  /** INI documents, applied in order (later wins). */
  sources?: string[];
  env?: Record<string, string | undefined>;
  /** Only env vars with this prefix are used. Defaults to "APP_". */
  envPrefix?: string;
}

/** Merge defaults, INI sources and environment variables into one config object. */
export function loadConfig(options: LoadOptions = {}): ConfigObject {
  const layers: ConfigObject[] = [];
  if (options.defaults) layers.push(options.defaults);
  for (const source of options.sources ?? []) layers.push(parseIni(source));
  if (options.env) layers.push(fromEnv(options.env, options.envPrefix ?? 'APP_'));
  return deepMerge(...layers);
}
