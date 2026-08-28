import { ProjectSlug } from "@todou/shared";
import { CliError } from "./errors.ts";

export function parsePositiveInt(value: string, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError(`${what} must be a positive integer, got "${value}"`);
  }
  return n;
}

/** Positive seconds; fractions allowed so tests and tight loops can go sub-second. */
export function parseSeconds(value: string, what: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(
      `${what} must be a positive number of seconds, got "${value}"`,
    );
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

/**
 * gh's repeatable list flags also split on commas — `--label "bug,ui"` is
 * two labels there — and agents write them that way at every CLI (T-135).
 * The cost is that a comma can no longer appear inside a name, which is the
 * same trade gh makes.
 */
export function splitCommaList(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/**
 * The API's `#rrggbb`, from any spelling a user is likely to reach for:
 * gh takes its label colors bare (`ff0000`), and CSS shorthand (`#f00`) is
 * what anyone who writes stylesheets types by reflex.
 */
export function parseColor(value: string, what: string): string {
  const hex = (value.startsWith("#") ? value.slice(1) : value).toLowerCase();
  const full = /^[0-9a-f]{3}$/.test(hex)
    ? [...hex].map((digit) => digit.repeat(2)).join("")
    : hex;
  if (!/^[0-9a-f]{6}$/.test(full)) {
    throw new CliError(
      `${what} must be a hex color, got "${value}"`,
      `write it as #rrggbb — also accepted: rrggbb, #rgb (e.g. ${what} '#3b82f6')`,
    );
  }
  return `#${full}`;
}

export type IssueRef = {
  project?: string;
  number: number;
  /** Set for URL-form refs, so callers can reject a foreign server. */
  origin?: string;
};

const ISSUE_URL_PATH = /^\/projects\/([^/]+)\/issues\/([^/]+)\/?$/;

/**
 * A project's prefixed reference form (T-80), e.g. "T-76" or "FOOBAR-8".
 * Deliberately loose: any well-formed prefix is accepted without checking
 * the project's configured one — the positional already names its project,
 * so the number is unambiguous and validating would cost a network call.
 */
const PREFIXED_REF = /^[A-Z][A-Z0-9_]*-(\d{1,9})$/;

/** The slug-qualified form `project#16`; the slug's own charset excludes "#". */
const QUALIFIED_REF = /^([a-z0-9][a-z0-9-]*)#(\d{1,9})$/;

function parseIssueNumberToken(value: string, what: string): number {
  const prefixed = PREFIXED_REF.exec(value);
  if (prefixed?.[1] !== undefined) return Number(prefixed[1]);
  return parsePositiveInt(stripHash(value), what);
}

/**
 * An issue reference as agents habitually write it: "16", "#16", "T-16",
 * "project/16", "project/#16", "project/T-16", "project#16", or a full
 * issue URL. The "project#16" form is what cross-project references are
 * written as in prose (T-150), so it has to paste back in here.
 */
export function parseIssueRef(value: string, what: string): IssueRef {
  if (/^https?:\/\//i.test(value)) return parseIssueUrl(value, what);
  const qualified = QUALIFIED_REF.exec(value);
  if (qualified?.[1] !== undefined && qualified[2] !== undefined) {
    return {
      project: checkSlug(qualified[1], value),
      number: parsePositiveInt(qualified[2], what),
    };
  }
  const parts = value.split("/");
  if (parts.length === 1) {
    return { number: parseIssueNumberToken(value, what) };
  }
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    throw new CliError(
      `${what} must be <number> or <project>/<number>, got "${value}"`,
    );
  }
  return {
    project: checkSlug(parts[0] as string, value),
    number: parseIssueNumberToken(parts[1] as string, what),
  };
}

function parseIssueUrl(value: string, what: string): IssueRef {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`${what}: cannot parse URL "${value}"`);
  }
  const match = ISSUE_URL_PATH.exec(url.pathname);
  if (!match) {
    throw new CliError(
      `"${value}" is not an issue URL`,
      "expected <server>/projects/<project>/issues/<number>",
    );
  }
  return {
    project: checkSlug(match[1] as string, value),
    number: parsePositiveInt(match[2] as string, what),
    origin: url.origin,
  };
}

function checkSlug(slug: string, ref: string): string {
  if (!ProjectSlug.safeParse(slug).success) {
    throw new CliError(
      `invalid project slug "${slug}" in "${ref}"`,
      "project slugs use lowercase letters, digits, and dashes",
    );
  }
  return slug;
}

function stripHash(value: string): string {
  return value.startsWith("#") ? value.slice(1) : value;
}
