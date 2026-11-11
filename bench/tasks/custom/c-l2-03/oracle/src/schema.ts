import type { ConfigObject, ConfigValue } from './types.ts';
import { isPlainObject } from './path.ts';
import { parseDuration } from './duration.ts';

export type FieldSchema =
  | { type: 'string'; required?: boolean; default?: string; enum?: string[] }
  | { type: 'number'; required?: boolean; default?: number; integer?: boolean; min?: number; max?: number }
  | { type: 'boolean'; required?: boolean; default?: boolean }
  | { type: 'duration'; required?: boolean; default?: string | number }
  | { type: 'object'; properties: Schema };

export interface Schema {
  [key: string]: FieldSchema;
}

export interface ConfigIssue {
  /** Dotted path, e.g. "db.port". */
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; value: ConfigObject } | { ok: false; issues: ConfigIssue[] };

type LeafSchema = Exclude<FieldSchema, { type: 'object' }>;
type Check = { ok: true; value: ConfigValue } | { ok: false; message: string };

/**
 * Validate `config` against `schema`, coercing string values (env vars) to the
 * declared types and filling defaults. Collects every issue; never mutates `config`.
 */
export function validateConfig(config: ConfigObject, schema: Schema): ValidationResult {
  const issues: ConfigIssue[] = [];
  const value = validateObject(config, schema, '', issues);
  return issues.length === 0 ? { ok: true, value } : { ok: false, issues };
}

function validateObject(input: ConfigObject, schema: Schema, prefix: string, issues: ConfigIssue[]): ConfigObject {
  const out: ConfigObject = {};
  for (const [key, field] of Object.entries(schema)) {
    const path = prefix + key;
    const raw = Object.hasOwn(input, key) ? input[key] : undefined;

    if (field.type === 'object') {
      if (raw === undefined) out[key] = validateObject({}, field.properties, `${path}.`, issues);
      else if (isPlainObject(raw)) out[key] = validateObject(raw, field.properties, `${path}.`, issues);
      else issues.push({ path, message: 'expected object' });
      continue;
    }

    if (raw === undefined) {
      if (field.default !== undefined) {
        const result = checkLeaf(field, field.default);
        if (result.ok) out[key] = result.value;
        else issues.push({ path, message: result.message });
      } else if (field.required) {
        issues.push({ path, message: 'is required' });
      }
      continue;
    }

    const result = checkLeaf(field, raw);
    if (result.ok) out[key] = result.value;
    else issues.push({ path, message: result.message });
  }

  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema, key) && input[key] !== undefined) {
      issues.push({ path: prefix + key, message: 'unknown key' });
    }
  }
  return out;
}

function checkLeaf(field: LeafSchema, raw: ConfigValue): Check {
  switch (field.type) {
    case 'string': {
      if (typeof raw !== 'string') return { ok: false, message: 'expected string' };
      if (field.enum && !field.enum.includes(raw)) {
        return { ok: false, message: `must be one of: ${field.enum.join(', ')}` };
      }
      return { ok: true, value: raw };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n)) return { ok: false, message: 'expected number' };
      if (field.integer && !Number.isInteger(n)) return { ok: false, message: 'must be an integer' };
      if (field.min !== undefined && n < field.min) return { ok: false, message: `must be >= ${field.min}` };
      if (field.max !== undefined && n > field.max) return { ok: false, message: `must be <= ${field.max}` };
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (raw === true || raw === 'true') return { ok: true, value: true };
      if (raw === false || raw === 'false') return { ok: true, value: false };
      return { ok: false, message: 'expected boolean' };
    }
    case 'duration': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, message: 'expected duration' };
      try {
        return { ok: true, value: parseDuration(raw) };
      } catch {
        return { ok: false, message: 'expected duration' };
      }
    }
  }
}
