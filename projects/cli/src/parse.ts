import { CliError } from "./errors.ts";

export function parsePositiveInt(value: string, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError(`${what} must be a positive integer, got "${value}"`);
  }
  return n;
}

export function parseChoice<const T extends readonly string[]>(
  value: string,
  choices: T,
  what: string,
): T[number] {
  if (!(choices as readonly string[]).includes(value)) {
    throw new CliError(`${what} must be one of: ${choices.join(", ")}`);
  }
  return value as T[number];
}
