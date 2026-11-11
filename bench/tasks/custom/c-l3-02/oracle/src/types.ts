export type ConfigPrimitive = string | number | boolean | null;
export type ConfigValue = ConfigPrimitive | ConfigValue[] | ConfigObject;
export interface ConfigObject {
  [key: string]: ConfigValue | undefined;
}

/** One layer of configuration. `load()` is called again on every reload. */
export interface ConfigSource {
  /** Unique within one configuration; reported by `origin()` and `explain()`. */
  name: string;
  load(): ConfigObject;
}

/** One leaf that differs between two configurations; `undefined` means "not there". */
export interface ConfigChange {
  path: string;
  before: ConfigValue | undefined;
  after: ConfigValue | undefined;
}
