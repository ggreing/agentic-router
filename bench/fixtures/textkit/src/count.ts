const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** Number of words in `text`. Apostrophes inside a word ("don't") do not split it. */
export function wordCount(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Number of user-perceived characters, so emoji and combining marks count once. */
export function charCount(text: string): number {
  let count = 0;
  for (const _segment of graphemes.segment(text)) count++;
  return count;
}
