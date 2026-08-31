import type { CommandClass } from "clipanion";
import type { CliContext } from "./api-command.ts";

/** What may follow one first word: nothing, a set of verbs, or either. */
export type CommandGroup = {
  /** The first word runs on its own — `todou attach 16 file.png`. */
  bare: boolean;
  /** Second tokens in registration order, aliases included. */
  verbs: string[];
};

/** First word → what may follow it, in registration order. */
export type CommandTable = Map<string, CommandGroup>;

/**
 * Longer than any verb, and the bound on the O(mn) loop below: a token this
 * long is a pasted argument, not a typo, and must not buy a long comparison.
 */
const MAX_POINTS = 64;

/** More alternatives than this is the usage wall T-187 exists to remove. */
const MAX_SUGGESTIONS = 3;

/**
 * Case and width folded away. NFKC matters for the CJK input methods this
 * CLI is typed at: a half/full-width slip produces `ｌｉｓｔ`, which is the
 * right command spelled in the wrong code points.
 */
export function normalizeToken(raw: string): string {
  return raw.normalize("NFKC").toLowerCase();
}

function points(text: string): string[] {
  return Array.from(text).slice(0, MAX_POINTS);
}

/**
 * Optimal string alignment — Levenshtein plus adjacent transpositions,
 * which is the largest class of typing error — counted in code points.
 * UTF-16 units would count an astral CJK glyph or an emoji twice, inflating
 * both the distance and the length threshold derived from it; `format.ts`'s
 * `summarize` counts the same way for the same reason.
 */
export function osaDistance(a: string, b: string): number {
  const source = points(a);
  const target = points(b);
  const m = source.length;
  const n = target.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let twoAgo = Array.from({ length: n + 1 }, () => 0);
  let previous = Array.from({ length: n + 1 }, (_, j) => j);
  let current = Array.from({ length: n + 1 }, () => 0);

  for (let i = 1; i <= m; i++) {
    current[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = source[i - 1] === target[j - 1] ? 0 : 1;
      let best = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        source[i - 1] === target[j - 2] &&
        source[i - 2] === target[j - 1]
      ) {
        best = Math.min(best, twoAgo[j - 2] + cost);
      }
      current[j] = best;
    }
    const spare = twoAgo;
    twoAgo = previous;
    previous = current;
    current = spare;
  }
  return previous[n];
}

/**
 * The routing table, read off the same array the CLI registers. Deriving it
 * rather than writing it down is what keeps a suggestion from naming a
 * command that no longer exists, or missing one that just landed.
 */
export function commandTable(
  commands: ReadonlyArray<CommandClass<CliContext>>,
): CommandTable {
  const table: CommandTable = new Map();
  for (const command of commands) {
    for (const path of command.paths ?? []) {
      if (path.length === 0) continue;
      const first = path[0];
      const group = table.get(first) ?? { bare: false, verbs: [] };
      table.set(first, group);
      if (path.length === 1) {
        group.bare = true;
      } else if (!group.verbs.includes(path[1])) {
        group.verbs.push(path[1]);
      }
    }
  }
  return table;
}

/**
 * The candidates worth printing for a token nobody recognized, best first.
 *
 * A candidate qualifies on distance — within a third of the longer of the
 * two spellings, so short verbs stay strict and long ones forgive more — or
 * on a prefix relation, which covers the truncations distance rejects
 * (`del` sits 3 edits from `delete`, well past its own threshold).
 */
export function suggestVerbs(
  input: string,
  candidates: readonly string[],
): string[] {
  const needle = normalizeToken(input);
  const needleLength = points(needle).length;
  return candidates
    .map((candidate, index) => {
      const target = normalizeToken(candidate);
      const targetLength = points(target).length;
      const distance = osaDistance(needle, target);
      return {
        candidate,
        index,
        distance,
        targetLength,
        prefix:
          needleLength >= 2 &&
          (target.startsWith(needle) || needle.startsWith(target)),
        near: distance <= Math.ceil(Math.max(needleLength, targetLength) / 3),
      };
    })
    .filter((scored) => scored.prefix || scored.near)
    .sort(
      (a, b) =>
        Number(b.prefix) - Number(a.prefix) ||
        (a.prefix ? a.targetLength - b.targetLength : 0) ||
        a.distance - b.distance ||
        a.index - b.index,
    )
    .slice(0, MAX_SUGGESTIONS)
    .map((scored) => scored.candidate);
}

/**
 * The error lines for an argv clipanion is certain to reject, or `null` to
 * let it through.
 *
 * A precheck rather than a hook into clipanion's own error formatting: the
 * shape of its candidate list is internal API that an upgrade may change,
 * while a table derived from `paths` cannot drift from what is registered.
 * It answers only for inputs that have no reading at all, and stays quiet
 * whenever a token could still be a positional — an unrecognized command is
 * a poor thing to be right about at the cost of refusing a valid one.
 */
export function guardUnknownCommand(
  argv: readonly string[],
  table: CommandTable,
): string[] | null {
  if (argv.length === 0) return null;
  const first = argv[0];
  if (first.startsWith("-")) return null;
  if (argv.some((token) => token === "-h" || token === "--help")) return null;

  const group = table.get(first);
  if (group === undefined) return unknownFirstWord(first, table);
  // A first word that also runs alone takes positionals of its own, and
  // `attach lst 3` cannot be told apart from a file named `lst`.
  if (group.bare) return null;

  if (argv.length < 2 || argv[1].startsWith("-")) {
    return [
      `error: '${first}' needs a subcommand`,
      subcommandList(first, group),
      `run 'todou ${first} <subcommand> --help' for details`,
    ];
  }
  const second = argv[1];
  if (group.verbs.includes(second)) return null;

  const matches = suggestVerbs(second, group.verbs);
  return [
    `error: unknown command '${first} ${second}'`,
    ...(matches.length === 0
      ? [subcommandList(first, group)]
      : didYouMean(matches.map((verb) => `todou ${first} ${verb}`))),
  ];
}

function unknownFirstWord(first: string, table: CommandTable): string[] {
  const head = `error: unknown command '${first}'`;
  // `todou list` names a verb several groups share; which group was meant is
  // the only open question, so every full path is shown and none is cut.
  const needle = normalizeToken(first);
  const shared: string[] = [];
  for (const [name, group] of table) {
    for (const verb of group.verbs) {
      if (normalizeToken(verb) === needle) shared.push(`todou ${name} ${verb}`);
    }
  }
  if (shared.length > 0) return [head, ...didYouMean(shared)];

  const matches = suggestVerbs(first, [...table.keys()]);
  if (matches.length > 0) {
    return [head, ...didYouMean(matches.map((name) => `todou ${name}`))];
  }
  return [
    head,
    `commands: ${[...table.keys()].join(", ")}`,
    "run 'todou --help' for details",
  ];
}

function didYouMean(paths: string[]): string[] {
  return paths.length === 1
    ? [`did you mean '${paths[0]}'?`]
    : ["did you mean one of:", ...paths.map((path) => `  ${path}`)];
}

function subcommandList(first: string, group: CommandGroup): string {
  return `subcommands of '${first}': ${group.verbs.join(", ")}`;
}
