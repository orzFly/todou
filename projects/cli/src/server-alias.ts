import type { CliConfig } from "./config.ts";
import { normalizeServer } from "./config.ts";
import { CliError } from "./errors.ts";

/**
 * One deployment answering at more than one address (T-311).
 *
 * A base URL is scheme, host, optional port and optional path prefix with no
 * trailing slash — what `normalizeServer` produces and what `[servers.…]`
 * keys already are. An alias is another base URL the same deployment answers
 * at, listed on the entry it belongs to:
 *
 *     [servers."http://198.51.100.7/todou"]
 *     instead_of = ["https://todou.example"]
 *
 * The name and the reading are git's `url.<base>.insteadOf`: a URL written at
 * the alias is the real base. The matching deliberately does NOT follow git's
 * byte-prefix comparison, in both directions. A raw prefix lets the base
 * `https://todou.example` claim `https://todou.example.attacker.test/…` — a
 * link pasted from a hostile host, read as one addressing the user's own
 * tracker — and lets the prefix `/todou` claim `/todoubar/…`, which is simply
 * another path. Comparing origins and path *segments* costs nothing here:
 * these are single URLs on an argument path, never a hot loop.
 */

/** A base URL as a key: normalized, no trailing slash. */
export type AliasRow = { alias: string; server: string };

/** Every `instead_of` entry in the config, flattened and normalized. */
export function buildAliasTable(config: CliConfig): AliasRow[] {
  const rows: AliasRow[] = [];
  for (const [server, entry] of Object.entries(config.servers)) {
    for (const alias of entry.instead_of) {
      rows.push({
        alias: normalizeServer(alias),
        server: normalizeServer(server),
      });
    }
  }
  return rows;
}

/**
 * `base` covers `url`: same origin, and `base`'s path is a segment-wise
 * prefix of `url`'s. Returns what is left of the path — "" when they are
 * equal — or null when it does not cover.
 *
 * `URL.origin` is what makes `HTTPS://Todou.Example:443` and
 * `https://todou.example` one base: it lowercases the host and drops a
 * default port. Anything that does not parse is a miss, not an error — the
 * callers' own messages are better than anything this layer could say.
 */
export function baseRemainder(url: string, base: string): string | null {
  let target: URL;
  let root: URL;
  try {
    target = new URL(url);
    root = new URL(base);
  } catch {
    return null;
  }
  if (target.origin !== root.origin) return null;
  const prefix = root.pathname.replace(/\/+$/, "");
  const path = target.pathname;
  if (prefix !== "" && path !== prefix && !path.startsWith(`${prefix}/`)) {
    return null;
  }
  const rest = prefix === "" ? path : path.slice(prefix.length);
  // "/" is the origin root, which names no path of its own.
  return `${rest === "/" ? "" : rest}${target.search}${target.hash}`;
}

/**
 * `given` with a matching alias replaced by the server it names; `given`
 * unchanged when nothing matches or it does not parse as a URL. Longest
 * alias wins; a tie between different servers throws CliError.
 */
export function rewriteServer(
  given: string,
  table: AliasRow[],
): { server: string; from?: string } {
  const matches = table.filter(
    (row) => baseRemainder(given, row.alias) !== null,
  );
  if (matches.length === 0) return { server: given };
  // Longest first: a deployment mounted at /todou and another at
  // /todou/staging stay distinguishable.
  const longest = Math.max(...matches.map((row) => row.alias.length));
  const winners = matches.filter((row) => row.alias.length === longest);
  const servers = [...new Set(winners.map((row) => row.server))];
  if (servers.length > 1) {
    // Only a contradiction that actually matched fails here: a duplicate
    // somewhere else in the file must not break every command.
    throw new CliError(
      `"${given}" could be ${servers.join(" or ")} — one address cannot be two servers`,
      "fix instead_of in your config so each alias is listed under one server",
    );
  }
  const winner = winners[0] as AliasRow;
  return { server: winner.server, from: winner.alias };
}

/**
 * The base that covers `url`, of those given; null when none does. The
 * longest wins, so a deployment mounted at `/todou` and another at
 * `/todou/staging` stay distinguishable.
 *
 * This is the one place that choice is made, so a localization and the
 * error explaining a failed one name the same base by construction — the
 * two had drifted apart when the failure path compared origins instead,
 * which is the bug that let a *different configured server* be reported as
 * an unconfigured address (T-311 review).
 */
export function coveringBase(url: string, bases: string[]): string | null {
  let winner: string | null = null;
  for (const base of bases) {
    if (baseRemainder(url, base) === null) continue;
    const normalized = normalizeServer(base);
    if (winner === null || normalized.length > winner.length)
      winner = normalized;
  }
  return winner;
}

/**
 * A URL-form reference as a root-relative address the path parser takes
 * (`/projects/p/issues/159#comment-3721`). Query and fragment are carried
 * over; the longest base wins. Three outcomes, all distinct:
 *
 * - a non-empty address — a base covered it, hand it to the parser;
 * - `""` — a base covered it, but it addresses the base root and names no
 *   issue, so the caller raises the existing `is not an issue URL`;
 * - `null` — no base covered it, so the caller tries the declared public
 *   origin and then fails.
 */
export function localizeIssueUrl(raw: string, bases: string[]): string | null {
  const base = coveringBase(raw, bases);
  return base === null ? null : baseRemainder(raw, base);
}
