import type { ConfigObject, ConfigSource } from '../types.ts';
import { ConfigError } from '../errors.ts';
import { isPlainObject } from '../path.ts';
import { read } from './object.ts';
import type { Lazy } from './object.ts';

/** A JSON document as a layer. The top level must be an object. */
export function jsonSource(name: string, text: Lazy<string>): ConfigSource {
  return {
    name,
    load(): ConfigObject {
      let parsed: unknown;
      try {
        parsed = JSON.parse(read(text));
      } catch (err) {
        throw new ConfigError(`invalid JSON in source "${name}": ${(err as Error).message}`);
      }
      if (!isPlainObject(parsed)) {
        throw new ConfigError(`invalid JSON in source "${name}": the top level must be an object`);
      }
      return parsed;
    },
  };
}
