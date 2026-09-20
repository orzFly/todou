import { RuntimeError } from "./protocol.ts";
import type { ResourcePolicy } from "./resources.ts";

export interface RuntimeTimer {
  cancel(): void;
}
export interface RuntimeTimers {
  setTimeout(callback: () => void, milliseconds: number): RuntimeTimer;
  clearTimeout(timer: RuntimeTimer): void;
}
export const defaultTimers: RuntimeTimers = {
  setTimeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    return { cancel: () => clearTimeout(timer) };
  },
  clearTimeout: (timer) => timer.cancel(),
};
export function shouldRetry(
  error: unknown,
  failures: number,
  policy: ResourcePolicy,
): boolean {
  const failure = error as {
    status?: number;
    name?: string;
    kind?: string;
  } | null;
  if (
    failure?.name === "AbortError" ||
    failure?.kind === "cancelled" ||
    failure?.kind === "session-reset" ||
    failure?.kind === "protocol"
  )
    return false;
  if (
    failure?.status !== undefined &&
    failure.status >= 400 &&
    failure.status < 500
  )
    return false;
  return policy.retryOwner === "runtime" && failures < policy.retries;
}
export function retryDelay(failures: number): number {
  return Math.min(1000 * 2 ** failures, 30_000);
}
export function abortError(): RuntimeError {
  return new RuntimeError("cancelled", "Read cancelled");
}
