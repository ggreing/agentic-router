import type { ConfigObject } from './types.ts';
import type { Schema } from './schema.ts';
import { parseIni } from './parse.ts';
import { fromEnv } from './env.ts';
import { deepMerge } from './merge.ts';
import { validateConfig } from './schema.ts';
import { ConfigError } from './errors.ts';

export interface LoadOptions {
  defaults?: ConfigObject;
  /** INI documents, applied in order (later wins). */
  sources?: string[];
  env?: Record<string, string | undefined>;
  /** Only env vars with this prefix are used. Defaults to "APP_". */
  envPrefix?: string;
  /** When given, the merged config is validated and coerced; invalid config throws ConfigError. */
  schema?: Schema;
}

/** Merge defaults, INI sources and environment variables into one config object. */
export function loadConfig(options: LoadOptions = {}): ConfigObject {
  const layers: ConfigObject[] = [];
  if (options.defaults) layers.push(options.defaults);
  for (const source of options.sources ?? []) layers.push(parseIni(source));
  if (options.env) layers.push(fromEnv(options.env, options.envPrefix ?? 'APP_'));
  const merged = deepMerge(...layers);
  if (!options.schema) return merged;

  const result = validateConfig(merged, options.schema);
  if (!result.ok) {
    const summary = result.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${summary}`, { issues: result.issues });
  }
  return result.value;
}
