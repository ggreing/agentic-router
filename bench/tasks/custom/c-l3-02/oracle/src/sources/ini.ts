import type { ConfigSource } from '../types.ts';
import { parseIni } from '../parse.ts';
import { read } from './object.ts';
import type { Lazy } from './object.ts';

/** An INI document as a layer. */
export function iniSource(name: string, text: Lazy<string>): ConfigSource {
  return { name, load: () => parseIni(read(text)) };
}
