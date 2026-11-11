import type { ConfigSource } from '../types.ts';
import { fromEnv } from '../env.ts';

/** Environment variables with a prefix as a layer (see fromEnv). The env object is read on every load. */
export function envSource(env: Record<string, string | undefined>, prefix = 'APP_', name = 'env'): ConfigSource {
  return { name, load: () => fromEnv(env, prefix) };
}
