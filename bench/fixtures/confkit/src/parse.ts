import type { ConfigObject, ConfigValue } from './types.ts';
import { ConfigError } from './errors.ts';
import { isPlainObject } from './path.ts';

/**
 * Parse INI-style text.
 *
 *   # comment            ; also a comment
 *   name = api
 *   [db.replica]
 *   host = "replica.local"
 *   port = 5433
 *
 * Unquoted `true`/`false` become booleans and numeric values become numbers.
 * Quoted values are always strings.
 */
export function parseIni(text: string): ConfigObject {
  const root: ConfigObject = {};
  let section = root;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = enterSection(root, header[1].trim(), i + 1);
      continue;
    }

    const eq = line.indexOf('=');
    if (eq <= 0) throw new ConfigError('expected "key = value"', { line: i + 1 });
    section[line.slice(0, eq).trim()] = parseValue(line.slice(eq + 1).trim());
  }
  return root;
}

function enterSection(root: ConfigObject, name: string, line: number): ConfigObject {
  let current = root;
  for (const segment of name.split('.').map((s) => s.trim())) {
    if (segment === '') throw new ConfigError(`invalid section name [${name}]`, { line });
    const next = current[segment];
    if (next === undefined) {
      const created: ConfigObject = {};
      current[segment] = created;
      current = created;
    } else if (isPlainObject(next)) {
      current = next;
    } else {
      throw new ConfigError(`section [${name}] conflicts with an existing value`, { line });
    }
  }
  return current;
}

function parseValue(raw: string): ConfigValue {
  const quote = raw[0];
  if (raw.length >= 2 && (quote === '"' || quote === "'") && raw.endsWith(quote)) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}
