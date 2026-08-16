import { formatRef, refToken } from "@todou/shared";

/**
 * How a project spells its issue numbers, restated on the envelope of every
 * issue-related `--json` payload (T-134). A consumer that only ever sees
 * `"number": 1` cannot tell `#1` from `T-1`, and a guessed ref links
 * nowhere — so the format is stated outright, including on an empty page
 * where no `ref` is there to infer it from.
 */
export type RefFormat = {
  /** The project's configured prefix; null = the default `#N` form. */
  prefix: string | null;
  /** What a ref starts with: `T-` or `#`. Append the number to spell one. */
  token: string;
};

export function refFormat(prefix: string | null): RefFormat {
  return { prefix, token: refToken(prefix) };
}

/** An issue-shaped payload with its spelled ref beside the bare number. */
export function withRef<T extends { number: number }>(
  issue: T,
  prefix: string | null,
): T & { ref: string } {
  return { ...issue, ref: formatRef(prefix, issue.number) };
}

/** An activity item with its spelled ref beside `issue_number`. */
export function withIssueRef<T extends { issue_number: number }>(
  item: T,
  prefix: string | null,
): T & { issue_ref: string } {
  return { ...item, issue_ref: formatRef(prefix, item.issue_number) };
}
