export interface ConfigErrorOptions {
  /** Dotted config path the problem relates to, e.g. "db.port". */
  path?: string;
  /** 1-based line number in an INI source. */
  line?: number;
}

export class ConfigError extends Error {
  readonly path: string | undefined;
  readonly line: number | undefined;

  constructor(message: string, options: ConfigErrorOptions = {}) {
    const where = options.line !== undefined ? `line ${options.line}: ` : options.path ? `${options.path}: ` : '';
    super(where + message);
    this.name = 'ConfigError';
    this.path = options.path;
    this.line = options.line;
  }
}
