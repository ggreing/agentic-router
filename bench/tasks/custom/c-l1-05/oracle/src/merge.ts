import type { ConfigObject, ConfigValue } from './types.ts';
import { isPlainObject } from './path.ts';

/** Keys that could reach Object.prototype when copied onto a plain object. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep-merge configuration layers; later layers win.
 * Nested objects are merged key by key; everything else (arrays included) is replaced.
 * Inputs are never mutated and the result shares no nested objects/arrays with them.
 * `undefined` values are skipped, so they never override an earlier layer.
 */
export function deepMerge(...layers: ConfigObject[]): ConfigObject {
  const result: ConfigObject = {};
  for (const layer of layers) mergeInto(result, layer);
  return result;
}

function mergeInto(target: ConfigObject, source: ConfigObject): void {
  for (const [key, value] of Object.entries(source)) {
    if (FORBIDDEN_KEYS.has(key) || value === undefined) continue;
    const existing = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isPlainObject(existing) && isPlainObject(value)) {
      mergeInto(existing, value);
    } else {
      target[key] = clone(value);
    }
  }
}

/** Deep copy of plain objects and arrays (dropping forbidden keys and undefined values). */
function clone(value: ConfigValue): ConfigValue {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const copy: ConfigObject = {};
    mergeInto(copy, value);
    return copy;
  }
  return value;
}
