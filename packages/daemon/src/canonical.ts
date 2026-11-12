// One spelling per location for path comparisons. A containment check that compares a resolved path with an
// unresolved one refuses paths that are inside: macOS temp folders (/var -> /private/var), repositories under a
// symlinked or junctioned folder, Windows 8.3 profile names (C:\Users\RUNNER~1 vs C:\Users\runneradmin), and a
// path whose last parts do not exist yet (the OS resolves nothing for them). Both sides go through
// canonicalPath, and the check itself stays as strict as before.
import fs from 'node:fs';
import path from 'node:path';

const realpath = fs.realpathSync.native ?? fs.realpathSync;

/**
 * The absolute path with its longest existing prefix resolved by the OS (links, junctions, short names, the
 * stored letter case where the OS reports it) and the parts below that, which do not exist, appended as given.
 * Those parts cannot be links, so the result names the place the path would reach. Never throws.
 */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpath(cur);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;   // not even the root resolves: compare as given
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Whether `target` is `dir` or inside it, both canonicalized. */
export function isWithin(dir: string, target: string): boolean {
  const rel = path.relative(canonicalPath(dir), canonicalPath(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** `target` relative to `dir` with forward slashes, both canonicalized; undefined when it is not inside. */
export function relativeWithin(dir: string, target: string): string | undefined {
  const rel = path.relative(canonicalPath(dir), canonicalPath(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.replace(/\\/g, '/');
}
