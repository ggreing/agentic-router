export interface SlugifyOptions {
  /** Joins the words of the slug. Defaults to '-'. */
  separator?: string;
}

/**
 * Convert arbitrary text into a URL-friendly slug.
 * Latin diacritics are stripped; letters and digits of any script are kept.
 *
 *   slugify('Hello, World!')  // 'hello-world'
 *   slugify('Crème Brûlée')   // 'creme-brulee'
 *   slugify('안녕 세상')       // '안녕-세상'
 */
export function slugify(input: string, options: SlugifyOptions = {}): string {
  const separator = options.separator ?? '-';
  return input
    // NFD splits "é" into "e" + combining accent; strip the marks, then recompose
    // so that scripts like Hangul (decomposed into jamo by NFD) come back intact.
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
    .join(separator);
}
