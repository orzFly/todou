/**
 * Reference tokenizer, mirroring the server's extraction regexes
 * (projects/server/src/services/references.ts) so a ref that records a
 * `referenced` event is exactly a ref that renders as a link. The config
 * is per-content (T-80): `internalPrefix` is the format in force when the
 * content was CREATED, `autolinks` are the project's current rules.
 * Internal tokens are consumed first, so an autolink claiming "#" never
 * sees the `#N` tokens of content written while "#" was internal.
 */

export type RefConfig = {
  /** null = `#N`; 'T' = `T-N`. */
  internalPrefix: string | null;
  autolinks: Array<{ prefix: string; url_template: string }>;
};

export const DEFAULT_REF_CONFIG: RefConfig = {
  internalPrefix: null,
  autolinks: [],
};

export type RefSegment =
  | { type: "text"; value: string }
  | { type: "ref"; number: number; text: string }
  | { type: "ext"; href: string; text: string };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Token pattern for a literal prefix + 1-9 digits. Prefixes that start
 * with a word character also exclude a preceding hyphen, so SOME-T-76
 * stays text; symbol prefixes ("#") keep the historical \W boundary.
 */
function tokenPattern(prefix: string, isHash: boolean): RegExp {
  const boundary = isHash ? String.raw`\W` : String.raw`[^\w-]`;
  return new RegExp(
    String.raw`(?:^|${boundary})(${escapeRegExp(prefix)}(\d{1,9}))\b`,
    "g",
  );
}

function internalPattern(internalPrefix: string | null): RegExp {
  return internalPrefix === null
    ? tokenPattern("#", true)
    : tokenPattern(`${internalPrefix}-`, false);
}

type Match = { start: number; token: string; digits: string };

function* scan(text: string, pattern: RegExp): Generator<Match> {
  for (const match of text.matchAll(pattern)) {
    const token = match[1] as string;
    yield {
      // The regex consumes the preceding boundary char; the token starts
      // after it.
      start: match.index + match[0].length - token.length,
      token,
      digits: match[2] as string,
    };
  }
}

function splitText(
  text: string,
  pattern: RegExp,
  toSegment: (m: Match) => RefSegment,
): RefSegment[] {
  const out: RefSegment[] = [];
  let last = 0;
  for (const m of scan(text, pattern)) {
    if (m.start > last)
      out.push({ type: "text", value: text.slice(last, m.start) });
    out.push(toSegment(m));
    last = m.start + m.token.length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

/** Split plain text into literal runs, internal refs, and autolinks. */
export function splitIssueRefs(
  text: string,
  config: RefConfig = DEFAULT_REF_CONFIG,
): RefSegment[] {
  let segments = splitText(
    text,
    internalPattern(config.internalPrefix),
    (m) => ({
      type: "ref",
      number: Number(m.digits),
      text: m.token,
    }),
  );
  for (const rule of config.autolinks) {
    const pattern = tokenPattern(
      rule.prefix,
      !/^[A-Za-z0-9_]/.test(rule.prefix),
    );
    segments = segments.flatMap((segment) =>
      segment.type === "text"
        ? splitText(segment.value, pattern, (m) => ({
            type: "ext",
            href: rule.url_template.replace("<num>", m.digits),
            text: m.token,
          }))
        : [segment],
    );
  }
  return segments;
}
