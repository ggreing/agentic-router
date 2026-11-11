import { TextkitError } from './errors.ts';

export interface WordWrapOptions {
  /** Split words longer than `width` into width-sized pieces. Defaults to false. */
  breakLongWords?: boolean;
}

/**
 * Greedy word wrap: joins words with single spaces into lines of at most
 * `width` characters. Existing line breaks are kept and each input line is
 * wrapped on its own. A word longer than `width` stays whole on its own line
 * unless `breakLongWords` is set.
 *
 *   wordWrap('the quick brown fox', 10) // 'the quick\nbrown fox'
 */
export function wordWrap(text: string, width: number, options: WordWrapOptions = {}): string {
  if (!Number.isInteger(width) || width < 1) {
    throw new TextkitError('width must be a positive integer');
  }
  const breakLongWords = options.breakLongWords ?? false;
  return text
    .split('\n')
    .map((line) => wrapLine(line, width, breakLongWords))
    .join('\n');
}

function wrapLine(line: string, width: number, breakLongWords: boolean): string {
  const words = line.split(/\s+/).filter((word) => word !== '');
  const pieces = breakLongWords ? words.flatMap((word) => chunk(word, width)) : words;
  const lines: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current === '') {
      current = piece;
    } else if (current.length + 1 + piece.length <= width) {
      current += ' ' + piece;
    } else {
      lines.push(current);
      current = piece;
    }
  }
  if (current !== '') lines.push(current);
  return lines.join('\n');
}

function chunk(word: string, width: number): string[] {
  if (word.length <= width) return [word];
  const pieces: string[] = [];
  for (let i = 0; i < word.length; i += width) pieces.push(word.slice(i, i + width));
  return pieces;
}
