import { useState } from "react";
import { classifyReadFailure, type ReadFailureKind } from "@/lib/http-status";

function messageOf(error: unknown): string {
  // Consumers use these strings as render guards, so a real failure must
  // always produce nonempty text.
  const message =
    error instanceof Error ? error.message || String(error) : String(error);
  return message.trim().length > 0 ? message : "Unknown error";
}

/**
 * Chooses the mutually exclusive page-level treatment for a failed read.
 * `replace` occupies an empty or refused surface; `notice` accompanies cached
 * content after a transient failure. Session failures belong to AuthedLayout.
 *
 * The cold failure message is latched until content arrives or session loss
 * supersedes it, so its surface survives a retry without outliving its owner.
 */
export function useReadFailure(
  error: unknown | null,
  hasContent: boolean,
): { replace: string | null; notice: string | null } {
  const failure: { kind: ReadFailureKind; message: string } | null =
    error === null
      ? null
      : { kind: classifyReadFailure(error), message: messageOf(error) };
  const [coldFailure, setColdFailure] = useState<string | null>(null);

  if (hasContent) {
    if (coldFailure !== null) setColdFailure(null);
  } else if (
    failure !== null &&
    failure.kind !== "session" &&
    failure.message !== coldFailure
  ) {
    setColdFailure(failure.message);
  }

  if (failure?.kind === "session") {
    if (coldFailure !== null) setColdFailure(null);
    return { replace: null, notice: null };
  }
  if (coldFailure !== null) {
    return { replace: coldFailure, notice: null };
  }
  if (failure?.kind === "refused") {
    return { replace: failure.message, notice: null };
  }
  if (failure?.kind === "transient") {
    return { replace: null, notice: failure.message };
  }
  return { replace: null, notice: null };
}
