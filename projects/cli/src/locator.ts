import type {
  ContestedInterval,
  PrefixClaimEntry,
  ReferenceConfig,
  ReferenceDirectory,
} from "@todou/shared";
import { formatRef, resolveClaim } from "@todou/shared";
import { CliError } from "./errors.ts";
import { suggestVerbs } from "./suggest.ts";

/**
 * Which project a positional's prefix names (T-214).
 *
 * Before this, `T-76` and `FOO-76` were both read as "issue 76 of whatever
 * project is current" — so a ref pasted from another project silently
 * returned a different card, exit 0. The prefix is a name in a global
 * namespace (T-150), and this resolves it as one, by the same priority the
 * renderer uses: this project's own format, then its autolinks, then the
 * cross-project directory.
 *
 * Pure, and unaware of HTTP: the command base class does the reading and
 * hands the two documents in, which is what lets every rung be tested
 * without a server.
 */
export type LadderInputs = {
  /** The current project (-p / env / dir-config / binding), if there is one. */
  project: string | undefined;
  /** Its reference config; null = unreadable, which opens the loose fallback. */
  config: ReferenceConfig | null;
  /**
   * The cross-project directory: `undefined` = not fetched, `null` = fetched
   * and unreadable, which reads as an empty one.
   */
  directory: ReferenceDirectory | null | undefined;
  /** Test seam; production leaves it unset and the decision is made now. */
  at?: string;
};

export type LadderResult =
  | { project: string }
  /**
   * The pre-T-214 reading, kept for when the config cannot be had: an old
   * server or a network blip must not fail a command over spelling, so the
   * number falls back to the current project (design §2.3).
   */
  | { project: string; loose: true };

/**
 * The first two rungs did not settle it — call again with `directory`
 * supplied. Asking for the document rather than taking it up front is what
 * keeps `todou issue view T-3` at the one request it already made, without
 * the caller having to know which rung needs what.
 */
export type NeedsDirectory = { needsDirectory: true };

/** `[from, to)`, the interval shape the directory hands out. */
function covers(
  claim: { from: string; to: string | null },
  time: number,
): boolean {
  return (
    Date.parse(claim.from) <= time &&
    (claim.to === null || time < Date.parse(claim.to))
  );
}

/**
 * The prefixes that would actually resolve if typed, at `at`. Judged by
 * `resolveClaim` rather than by listing every entry, so a prefix several
 * projects hold is left out: offering one that this very command refuses
 * would send the reader straight into a second failure.
 */
function prefixesInReach(
  entries: readonly PrefixClaimEntry[],
  contested: readonly ContestedInterval[],
  at: string,
): Array<{ prefix: string; slug: string }> {
  const reach = new Map<string, string>();
  for (const entry of entries) {
    if (reach.has(entry.prefix)) continue;
    const slug = resolveClaim(entries, contested, entry.prefix, at);
    if (slug !== null) reach.set(entry.prefix, slug);
  }
  return [...reach]
    .map(([prefix, slug]) => ({ prefix, slug }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

const MAX_LISTED = 5;

/** "mirror/3 or muon/3", "mirror/3, muon/3, or mica/3" — one Oxford list. */
function orList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}

function didYouMean(candidates: string[]): string {
  return candidates.length === 1
    ? `did you mean '${candidates[0]}'?`
    : `did you mean one of: ${candidates.map((c) => `'${c}'`).join(", ")}?`;
}

/** The `no project selected` wording, verbatim, so both paths read alike. */
function noProjectSelected(): CliError {
  return new CliError(
    "no project selected",
    "pass -p/--project <slug>, set TODOU_PROJECT, run `todou project link <slug>`, or add a .todou.toml",
  );
}

function conflictMessage(prefix: string, raw: string): string {
  return `prefix "${prefix}" is used by more than one project (from "${raw}")`;
}

/** Supplying the directory — `null` included — always yields a decision. */
export function resolvePrefixedRef(
  prefix: string,
  raw: string,
  inputs: LadderInputs & { directory: ReferenceDirectory | null },
): LadderResult;
export function resolvePrefixedRef(
  prefix: string,
  raw: string,
  inputs: LadderInputs,
): LadderResult | NeedsDirectory;
export function resolvePrefixedRef(
  prefix: string,
  raw: string,
  inputs: LadderInputs,
): LadderResult | NeedsDirectory {
  // The digits as written, not as parsed: every hint below pastes back into
  // a shell, and the renderer substitutes an autolink's <num> the same way.
  const digits = raw.slice(prefix.length + 1);
  const at = inputs.at ?? new Date().toISOString();
  const time = Date.parse(at);
  const { project, config } = inputs;

  if (project !== undefined) {
    if (config === null) return { project, loose: true };
    // Only the prefix in force now, never a retired one: admitting history
    // here would be a second resolution rule, and a ref in prose written
    // today would resolve elsewhere than the same token typed as an argument.
    if (prefix === config.format.prefix) return { project };
    const autolink = config.autolinks.find(
      (rule) => rule.prefix === `${prefix}-`,
    );
    if (autolink !== undefined) {
      throw new CliError(
        `"${raw}" uses the autolink prefix "${prefix}-", which points outside todou`,
        "autolinks are external links, not todou cards — it resolves to " +
          autolink.url_template.replace("<num>", digits),
      );
    }
  }

  if (inputs.directory === undefined) return { needsDirectory: true };

  const entries: readonly PrefixClaimEntry[] = inputs.directory?.entries ?? [];
  const contested: readonly ContestedInterval[] =
    inputs.directory?.contested ?? [];

  const claimed = resolveClaim(entries, contested, prefix, at);
  if (claimed !== null) return { project: claimed };

  const holders = entries.filter(
    (entry) => entry.prefix === prefix && covers(entry, time),
  );
  const qualified = [...new Set(holders.map((h) => h.slug))]
    .sort()
    .map((slug) => `${slug}/${digits}`);

  if (qualified.length >= 2) {
    throw new CliError(
      conflictMessage(prefix, raw),
      `write it qualified: ${orList(qualified.slice(0, MAX_LISTED))}`,
    );
  }
  if (contested.some((c) => c.prefix === prefix && covers(c, time))) {
    // The holder we cannot see is named nowhere — `contested` carries no
    // slug precisely so a viewer who can see only one holder learns of the
    // window without learning who else is in it.
    throw new CliError(
      conflictMessage(prefix, raw),
      qualified.length === 1
        ? `one of them is not readable to you; write it qualified, e.g. ${qualified[0]}`
        : `one of them is not readable to you; write it as <slug>/${digits} naming the project you mean`,
    );
  }

  // Nobody holds it. With no current project either, the missing project is
  // the real failure and the pre-T-214 message for it still fits.
  if (project === undefined) throw noProjectSelected();

  const reach = prefixesInReach(entries, contested, at);
  const near = suggestVerbs(
    prefix,
    reach.map((row) => row.prefix),
  );
  // Deliberately not "no project you can read": whether an unreadable
  // project holds it is neither known here nor worth implying.
  const head = `no project uses the prefix "${prefix}" (from "${raw}")`;
  if (near.length > 0) {
    throw new CliError(
      head,
      didYouMean(near.map((candidate) => `${candidate}-${digits}`)),
    );
  }
  const own = formatRef(config?.format.prefix ?? null, Number(digits));
  const listed = reach
    .slice(0, MAX_LISTED)
    .map((row) => `${row.prefix}- (${row.slug})`);
  if (reach.length > MAX_LISTED) listed.push("…");
  const parts = [
    `write this project's own card as "${own}" or "${project}/${digits}"`,
    ...(listed.length > 0 ? [`prefixes in reach: ${listed.join(", ")}`] : []),
  ];
  throw new CliError(head, parts.join("; "));
}

/**
 * The prefix in `slug/P-16`, checked against the project the slug names
 * (design §5). It used to be decoration — `dogfood/FOO-1` silently meant
 * `dogfood/1` — which is the same copy-paste accident as a bare foreign
 * prefix, one slug away.
 *
 * History is admitted here, unlike on the bare ladder's first rung: the slug
 * has already settled which project this is, so accepting a prefix it used
 * to write creates no second resolution rule, and pasting a ref out of an
 * old commit message is the main reason anyone types this form.
 */
export function checkQualifiedPrefix(
  slug: string,
  prefix: string,
  raw: string,
  config: ReferenceConfig | null,
): void {
  if (config === null) return;
  if (prefix === config.format.prefix) return;
  if (config.format.history.some((change) => change.prefix === prefix)) return;
  // Only `slug/PREFIX-digits` reaches here, so the digits start right after.
  const digits = raw.slice(slug.length + prefix.length + 2);
  const own = formatRef(config.format.prefix, Number(digits));
  throw new CliError(
    `"${raw}" says prefix "${prefix}", but project "${slug}" writes its issues as "${own}"`,
    `write "${slug}/${own}" or "${slug}/${digits}"`,
  );
}
