import type { ConfigObject } from './types.ts';
import { isPlainObject } from './path.ts';

/**
 * Deep-merge configuration layers; later layers win.
 * Nested objects are merged key by key; everything else (arrays included) is replaced.
 */
export function deepMerge(...layers: ConfigObject[]): ConfigObject {
  const result: ConfigObject = {};
  for (const layer of layers) mergeInto(result, layer);
  return result;
}

function mergeInto(target: ConfigObject, source: ConfigObject): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      mergeInto(existing, value);
    } else {
      target[key] = value;
    }
  }
}
