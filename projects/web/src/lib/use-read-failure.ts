import { hashKey, type QueryKey } from "@tanstack/react-query";
import { useState } from "react";
import { classifyReadFailure, type ReadFailureKind } from "@/lib/http-status";

function messageOf(error: unknown): string {
  // Consumers use these strings as render guards, so a real failure must
  // always produce nonempty text.
  const message =
    error instanceof Error ? error.message || String(error) : String(error);
  return message.trim().length > 0 ? message : "Unknown error";
}

type Failure = { kind: ReadFailureKind; message: string };

function dominantFailure(errors: readonly (unknown | null)[]): Failure | null {
  const failures = errors
    .filter((error) => error !== null)
    .map((error) => ({
      kind: classifyReadFailure(error),
      message: messageOf(error),
    }));
  return (
    failures.find(({ kind }) => kind === "refused") ??
    failures.find(({ kind }) => kind === "transient") ??
    failures.find(({ kind }) => kind === "session") ??
    null
  );
}

/**
 * Chooses one page-level treatment for all reads owned by a content surface.
 * Refusal wins over transient failure so a 5xx cannot leave data visible after
 * another read revoked it; session loss stays silent when it is the only kind.
 *
 * `identity` is part of the public lifecycle contract: pass the query key, or
 * a composite of every query key represented by this surface. It must stay
 * equal through a retry of the same reads and change whenever their data scope
 * changes. That keeps a cold failure mounted for Retry without leaking its
 * latched message into a different query. T-420's secondary surfaces use the
 * same rule rather than inventing another failure-state shape.
 */
export function useReadFailure(
  errors: readonly (unknown | null)[],
  hasContent: boolean,
  identity: QueryKey,
): { replace: string | null; notice: string | null } {
  const failure = dominantFailure(errors);
  const identityHash = hashKey(identity);
  const [coldFailure, setColdFailure] = useState<{
    identity: string;
    message: string;
  } | null>(null);
  const latchedMessage =
    coldFailure?.identity === identityHash ? coldFailure.message : null;
  const nextLatchedMessage =
    hasContent || failure?.kind === "session"
      ? null
      : (failure?.message ?? latchedMessage);

  if (
    (nextLatchedMessage === null && coldFailure !== null) ||
    (nextLatchedMessage !== null &&
      (coldFailure?.identity !== identityHash ||
        coldFailure.message !== nextLatchedMessage))
  ) {
    setColdFailure(
      nextLatchedMessage === null
        ? null
        : { identity: identityHash, message: nextLatchedMessage },
    );
  }

  if (failure?.kind === "session") {
    return { replace: null, notice: null };
  }
  if (nextLatchedMessage !== null) {
    return { replace: nextLatchedMessage, notice: null };
  }
  if (failure?.kind === "refused") {
    return { replace: failure.message, notice: null };
  }
  if (failure?.kind === "transient") {
    return { replace: null, notice: failure.message };
  }
  return { replace: null, notice: null };
}
