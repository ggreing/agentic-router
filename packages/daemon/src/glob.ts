// The one glob dialect of the router (audit #15, decision 94), shared with plugin/hooks/guard.mjs and
// fixed by the common table packages/core/test/fixtures/scope-glob-cases.json:
// - paths are relative to the git root, with "/" separators ("./" and "\" are normalised); a path that
//   leaves the root ("../") never matches
// - `**/` = zero or more segments, `**` = anything, `*` = within one segment, `?` = one character;
//   nothing else is special
// - directory forms (plain `dir`, `dir/`, `dir/**`) mean the directory and everything below it
// - case: scope matching follows the file system (case-insensitive on win32 and darwin, case-sensitive
//   on linux); protected and credential paths are always case-insensitive (deny more, never less)

export function normalizeGlob(glob: string): string {
  return glob.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '');

/** Whether scope globs match case-insensitively on this platform (the file system's rule). */
export function scopeCaseInsensitive(platform: string = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

export function globToRegExp(glob: string, caseInsensitive = true): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:[^/]*/)*'; }
        else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}

/** Whether repo-relative `file` matches `glob` in the router dialect. */
export function matchGlob(file: string, glob: string, caseInsensitive = true): boolean {
  let g = normalizeGlob(glob);
  const f = normalizePath(file);
  if (!g || f === '..' || f.startsWith('../') || f.startsWith('/')) return false;
  if (g.endsWith('/')) g += '**';
  if (!/[*?]/.test(g)) {
    const [lf, lg] = caseInsensitive ? [f.toLowerCase(), g.toLowerCase()] : [f, g];
    return lf === lg || lf.startsWith(`${lg}/`);
  }
  if (g.endsWith('/**') && matchGlob(f, g.slice(0, -3), caseInsensitive) && !/[*?]/.test(g.slice(0, -3))) return true;
  return globToRegExp(g, caseInsensitive).test(f);
}

/** Scope (allowed) matching: the file system's case rule. */
export const matchScope = (file: string, glob: string, platform: string = process.platform) => matchGlob(file, glob, scopeCaseInsensitive(platform));
export const matchesScope = (file: string, globs: readonly string[], platform: string = process.platform) => globs.some(g => matchScope(file, g, platform));

/** Protected / credential matching: always case-insensitive. */
export const matchesAny = (file: string, globs: readonly string[]) => globs.some(g => matchGlob(file, g, true));
