import type { Writable } from "node:stream";
import { GoneError, MovedError, TodouError } from "@todou/shared";
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

/**
 * A failure that names a project this account cannot reach (T-280), so the
 * reporter can offer a link asking someone who can for a role there.
 *
 * Raised where the judgement is made — which for a bare prefix is
 * `locator.ts`, a pure module that knows nothing of HTTP. It therefore
 * carries the target and no link: constructing one takes two requests, and
 * those belong to the reporter.
 */
export class NoAccessError extends CliError {
  /** The project as the user spelled it; never a server-resolved form. */
  readonly target: string;

  constructor(target: string, message: string, hint?: string) {
    super(message, hint);
    this.target = target;
  }
}

/**
 * One-line stderr rendering + exit code 1; unknown errors keep their stack.
 *
 * `extra` is appended last, whatever branch answered: it is the access-link
 * block (T-280), which the caller has to go and fetch — this stays a pure
 * function so every command that cannot produce that failure keeps calling it
 * unchanged.
 */
export function reportError(
  error: unknown,
  stderr: Writable,
  serverHint?: string,
  extra?: readonly string[],
): number {
  const code = renderError(error, stderr, serverHint);
  for (const line of extra ?? []) stderr.write(`${line}\n`);
  return code;
}

function renderError(
  error: unknown,
  stderr: Writable,
  serverHint?: string,
): number {
  if (error instanceof GoneError) {
    // The card existed and is gone from here; where it went is deliberately
    // not something this reader is told.
    const title = error.body.title;
    stderr.write(
      `error: ${title === undefined ? "this issue" : `"${title}"`} moved to a project you cannot read\n`,
    );
  } else if (error instanceof MovedError) {
    stderr.write(
      `error: moved to ${error.movedTo.slug}/${error.movedTo.number}\n`,
    );
  } else if (error instanceof TodouError) {
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
