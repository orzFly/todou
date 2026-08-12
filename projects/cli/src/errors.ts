import type { Writable } from "node:stream";
import { TodouError } from "@todou/shared";
import { ConfigError } from "@todou/shared/config";

/** A user-facing failure: printed as one line, optionally with a hint. */
export class CliError extends Error {
  readonly hint?: string;
  readonly exitCode: number = 1;

  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

/**
 * watch/poll exhausted its retry budget against transient network failures.
 * Exit code 4 lets loop scripts tell "server unreachable — rerun with the
 * same cursor" apart from 1 (fatal: bad flags, 4xx, config).
 */
export class RetriesExhaustedError extends CliError {
  override readonly exitCode = 4;
}

/** One-line stderr rendering + exit code 1; unknown errors keep their stack. */
export function reportError(
  error: unknown,
  stderr: Writable,
  serverHint?: string,
): number {
  if (error instanceof TodouError) {
    stderr.write(`error: ${error.code} — ${error.message}\n`);
  } else if (error instanceof CliError) {
    stderr.write(`error: ${error.message}\n`);
    if (error.hint) stderr.write(`${error.hint}\n`);
    return error.exitCode;
  } else if (error instanceof ConfigError) {
    stderr.write(`error: ${error.message}\n`);
  } else if (error instanceof TypeError) {
    // Undici surfaces connection failures as TypeError("fetch failed").
    stderr.write(
      `error: cannot reach ${serverHint ?? "the server"} — ${
        (error.cause as Error | undefined)?.message ?? error.message
      }\n`,
    );
  } else {
    throw error;
  }
  return 1;
}
