import type { ConfigObject, ConfigSource } from '../types.ts';
import { parseScalar } from '../parse.ts';
import { setPath } from '../path.ts';

/**
 * Command-line options as a layer.
 *
 *   --db.host=localhost   value after "="
 *   --port 8080           value in the next token (when it does not start with "--")
 *   --debug               no value: true
 *   --no-debug            false (never takes a value)
 *   --                    everything after it is ignored
 *
 * Values are coerced like unquoted INI values. Tokens that are neither an option nor an option's
 * value are ignored.
 */
export function parseArgv(argv: readonly string[]): ConfigObject {
  const result: ConfigObject = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    let key = eq >= 0 ? body.slice(0, eq) : body;
    let value: ReturnType<typeof parseScalar>;
    if (eq >= 0) {
      value = parseScalar(body.slice(eq + 1));
    } else if (key.startsWith('no-')) {
      key = key.slice(3);
      value = false;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = parseScalar(argv[++i]);
    } else {
      value = true;
    }
    const segments = key.split('.').filter((segment) => segment !== '');
    if (segments.length === 0) continue;
    setPath(result, segments, value);
  }
  return result;
}

export function argvSource(argv: readonly string[], name = 'argv'): ConfigSource {
  return { name, load: () => parseArgv(argv) };
}
