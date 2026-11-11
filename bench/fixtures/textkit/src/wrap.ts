import { TextkitError } from './errors.ts';

/**
 * Greedy word wrap: joins words with single spaces into lines of at most
 * `width` characters. A word longer than `width` is kept whole on its own line.
 *
 *   wordWrap('the quick brown fox', 10) // 'the quick\nbrown fox'
 */
export function wordWrap(text: string, width: number): string {
  if (!Number.isInteger(width) || width < 1) {
    throw new TextkitError('width must be a positive integer');
  }
  const words = text.split(/\s+/).filter((word) => word !== '');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines.join('\n');
}
