import type { ConfigIssue } from './schema.ts';

export interface ConfigErrorOptions {
  /** Dotted config path the problem relates to, e.g. "db.port". */
  path?: string;
  /** 1-based line number in an INI source. */
  line?: number;
  /** Schema validation problems (set by loadConfig when a schema rejects the config). */
  issues?: ConfigIssue[];
}

export class ConfigError extends Error {
  readonly path: string | undefined;
  readonly line: number | undefined;
  readonly issues: ConfigIssue[];

  constructor(message: string, options: ConfigErrorOptions = {}) {
    const where = options.line !== undefined ? `line ${options.line}: ` : options.path ? `${options.path}: ` : '';
    super(where + message);
    this.name = 'ConfigError';
    this.path = options.path;
    this.line = options.line;
    this.issues = options.issues ?? [];
  }
}
