/**
 * Split an identifier or phrase into lower-case words.
 * Understands camelCase, PascalCase, snake_case, kebab-case and plain text.
 *
 *   splitWords('parseHTTPResponse') // ['parse', 'http', 'response']
 */
export function splitWords(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function camelCase(input: string): string {
  const [first = '', ...rest] = splitWords(input);
  return first + rest.map(capitalize).join('');
}

export function pascalCase(input: string): string {
  return splitWords(input).map(capitalize).join('');
}

export function snakeCase(input: string): string {
  return splitWords(input).join('_');
}

export function kebabCase(input: string): string {
  return splitWords(input).join('-');
}

export function titleCase(input: string): string {
  return splitWords(input).map(capitalize).join(' ');
}
