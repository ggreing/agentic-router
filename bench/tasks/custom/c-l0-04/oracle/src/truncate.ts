import { TextkitError } from './errors.ts';

export interface TruncateOptions {
  /** Appended when the text is cut. Defaults to a single '…' character. */
  ellipsis?: string;
}

/**
 * Shorten `text` so that the result, including the ellipsis, is at most
 * `maxLength` characters long.
 *
 *   truncate('hello world', 8) // 'hello w…'
 */
export function truncate(text: string, maxLength: number, options: TruncateOptions = {}): string {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new TextkitError('maxLength must be a positive integer');
  }
  const ellipsis = options.ellipsis ?? '…';
  if (text.length <= maxLength) return text;
  if (maxLength <= ellipsis.length) return ellipsis.slice(0, maxLength);
  return text.slice(0, maxLength - ellipsis.length) + ellipsis;
}
