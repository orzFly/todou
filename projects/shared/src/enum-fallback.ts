/** A future enum member is a string; a missing required field is a bug. */
export function enumValue(value: unknown, name = "enum value"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

/** Keep compile-time exhaustiveness while accepting future wire values. */
export function enumLookup<K extends string, V>(
  values: Partial<Record<K, V>>,
  value: string,
  fallback: (unknownValue: string) => V,
  name = "enum value",
): V {
  enumValue(value, name);
  if (!Object.hasOwn(values, value)) return fallback(value);
  // hasOwn excludes inherited names such as constructor and __proto__.
  const key = value as K;
  const result = values[key];
  if (result === undefined) {
    throw new TypeError(`Missing mapping for ${name} "${value}"`);
  }
  return result;
}
