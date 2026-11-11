import type { ConfigObject, ConfigSource } from '../types.ts';
import { cloneValue } from '../path.ts';

/** Text (or anything else) given directly, or a function read again on every load. */
export type Lazy<T> = T | (() => T);

export function read<T>(input: Lazy<T>): T {
  return typeof input === 'function' ? (input as () => T)() : input;
}

/** A plain object as a layer, e.g. the defaults written in code. */
export function objectSource(name: string, value: Lazy<ConfigObject>): ConfigSource {
  return { name, load: () => cloneValue(read(value)) };
}
