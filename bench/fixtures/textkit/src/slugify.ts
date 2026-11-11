/**
 * Convert arbitrary text into a URL-friendly slug.
 *
 *   slugify('Hello, World!') // 'hello-world'
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
