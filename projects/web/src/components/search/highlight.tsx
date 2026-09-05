import type { SearchPart, SearchQualifier, SearchValue } from "@todou/shared";
import { canonicalQualifierValue, SEARCH_QUALIFIERS } from "@todou/shared";
import type { ReactNode } from "react";

/**
 * Whether a value names something. `unknown` is the honest answer while the
 * project's labels or statuses are still loading — it paints as valid, since
 * flashing every value amber and back is worse than being briefly quiet.
 */
export type ValueVerdict = "valid" | "special" | "invalid" | "unknown";

/** Names a key's values resolve against; absent = not loaded yet. */
export type KnownValues = Partial<Record<SearchQualifier, readonly string[]>>;

export function verdictOf(
  key: SearchQualifier,
  value: string,
  known: KnownValues,
): ValueVerdict {
  const spec = SEARCH_QUALIFIERS[key];
  if (spec.special.includes(value.toLowerCase())) return "special";
  if (spec.kind === "enum") {
    return canonicalQualifierValue(key, value) === null ? "invalid" : "valid";
  }
  const names = known[key];
  if (names === undefined) return spec.kind === "free" ? "valid" : "unknown";
  const wanted = value.toLowerCase();
  return names.some((n) => n.toLowerCase() === wanted) ? "valid" : "invalid";
}

/**
 * Every span carries colour and nothing else — no `padding`, no `margin`, no
 * `border`. This markup is painted behind a transparent input and has to
 * measure identically to the input's own text; anything that adds width slides
 * the caret off the character it is standing on. It is also why a qualifier
 * cannot be a rounded chip here, and why GitHub's own measures at `padding: 0`.
 */
const KEY_CLASS = "text-primary";
const PUNCT_CLASS = "text-muted-foreground";
const VALUE_CLASS: Record<ValueVerdict, string> = {
  valid: "text-foreground bg-primary/12 rounded-[3px]",
  special: "text-foreground bg-violet-500/15 rounded-[3px]",
  invalid: "text-amber-700 dark:text-amber-400 underline decoration-wavy",
  unknown: "text-foreground bg-primary/12 rounded-[3px]",
};

function valueSpans(
  part: Extract<SearchPart, { kind: "filter" }>,
  raw: string,
  known: KnownValues,
): ReactNode[] {
  const out: ReactNode[] = [];
  // The head is `-?key:`; the tail after the last value is whatever commas
  // and half-typed characters follow it. Walking offsets rather than
  // re-joining is what keeps this a faithful copy of the input's own text.
  let at = part.start;
  const push = (end: number, className?: string, key?: string) => {
    if (end <= at) return;
    out.push(
      <span key={key ?? `t${at}`} className={className}>
        {raw.slice(at, end)}
      </span>,
    );
    at = end;
  };
  push(part.keyStart, PUNCT_CLASS, `neg${part.start}`);
  push(part.keyEnd, KEY_CLASS, `key${part.start}`);
  for (const value of part.values as SearchValue[]) {
    push(value.start, PUNCT_CLASS, `sep${value.start}`);
    push(
      value.end,
      VALUE_CLASS[verdictOf(part.key, value.value, known)],
      `val${value.start}`,
    );
  }
  push(part.end, PUNCT_CLASS, `tail${part.start}`);
  return out;
}

/**
 * The parsed query as spans, for the mirror layer behind the input. A pure
 * function of the parts, so it is the same string the input holds — never a
 * re-tokenization that could disagree with it.
 */
export function highlightParts(
  raw: string,
  parts: SearchPart[],
  known: KnownValues = {},
): ReactNode[] {
  const out: ReactNode[] = [];
  for (const part of parts) {
    if (part.kind === "filter") {
      out.push(...valueSpans(part, raw, known));
    } else {
      out.push(
        <span key={`p${part.start}`}>{raw.slice(part.start, part.end)}</span>,
      );
    }
  }
  return out;
}
