export type ConfigPrimitive = string | number | boolean | null;
export type ConfigValue = ConfigPrimitive | ConfigValue[] | ConfigObject;
export interface ConfigObject {
  [key: string]: ConfigValue | undefined;
}
