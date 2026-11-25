// Assertions for the conformance cases. They run under vitest against Node's
// real modules and under tjs against the shims, so they depend on neither
// runtime's assert module.

function show(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function equal(
  actual: unknown,
  expected: unknown,
  what = "value",
): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${what}: got ${show(actual)}, want ${show(expected)}`);
  }
}

export function deepEqual(
  actual: unknown,
  expected: unknown,
  what = "value",
): void {
  if (show(actual) !== show(expected)) {
    throw new Error(`${what}: got ${show(actual)}, want ${show(expected)}`);
  }
}

export function ok(condition: unknown, what: string): void {
  if (!condition) throw new Error(`${what}: not true`);
}

/** The error `run` throws, for the caller to compare field by field. */
export async function rejection(
  run: () => Promise<unknown>,
  what: string,
): Promise<Error & Record<string, unknown>> {
  try {
    await run();
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error(`${what}: resolved, want a rejection`);
}

export type Cases<M> = Record<string, (mod: M) => Promise<void>>;
