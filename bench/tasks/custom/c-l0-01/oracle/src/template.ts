import { TextkitError } from './errors.ts';

export interface InterpolateOptions {
  /**
   * When true (the default) a placeholder without a value throws a TextkitError.
   * When false the placeholder is left in the output untouched.
   */
  strict?: boolean;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Replace `{{name}}` placeholders with values. `null` and `undefined` count as missing.
 *
 *   interpolate('Hi {{ name }}!', { name: 'Ada' }) // 'Hi Ada!'
 */
export function interpolate(
  template: string,
  values: Record<string, unknown>,
  options: InterpolateOptions = {},
): string {
  const strict = options.strict ?? true;
  return template.replace(PLACEHOLDER, (placeholder: string, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value !== undefined && value !== null) return String(value);
    if (strict) throw new TextkitError(`Missing value for placeholder "${name}"`);
    return placeholder;
  });
}
