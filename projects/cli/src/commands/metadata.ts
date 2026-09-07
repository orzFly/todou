import type {
  IssueMetadataEntry,
  IssueMetadataWriteEntry,
  MetadataNamespaceSelector,
  TodouClient,
} from "@todou/shared";
import { MetadataKey, MetadataNamespace, TodouError } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { readBody } from "../body.ts";
import { CliError } from "../errors.ts";
import { personName, relativeTime, table } from "../format.ts";
import { splitCommaList } from "../parse.ts";

/**
 * Machine-written state on a card (T-282). A command group of its own rather
 * than "reads here, writes through `todou api`": the main consumer is an
 * agent running this CLI, and hand-assembling a JSON body every time it moves
 * a state would put the whole cost on the only user there is.
 */

/** `--namespace` as the API spells it; no flag at all means every one. */
export function selectorOf(values: string[]): MetadataNamespaceSelector {
  const names = splitCommaList(values);
  if (names.length === 0 || names.includes("*")) return "*";
  for (const name of names) checkNamespace(name);
  return names;
}

function checkNamespace(name: string): string {
  if (!MetadataNamespace.safeParse(name).success) {
    throw new CliError(
      `"${name}" is not a namespace`,
      "lowercase letters, digits, and . - _ between them; 1–63 characters",
    );
  }
  return name;
}

function checkKey(key: string): string {
  if (!MetadataKey.safeParse(key).success) {
    throw new CliError(
      `"${key}" is not a key`,
      "lowercase letters, digits, and . - _ between them; 1–128 characters",
    );
  }
  return key;
}

/** `k=v`, splitting on the first `=` so a value may contain more. */
function splitPair(raw: string, flag: string): { key: string; value: string } {
  const at = raw.indexOf("=");
  if (at === -1) {
    throw new CliError(
      `${flag} needs <key>=<value>, got "${raw}"`,
      `write it as ${flag} key=value`,
    );
  }
  return { key: checkKey(raw.slice(0, at)), value: raw.slice(at + 1) };
}

/**
 * Entries grouped by namespace, in the order the API returned them — sorted
 * by `(namespace, key)`, so a group's rows are already adjacent and neither
 * end sorts twice.
 */
function groupByNamespace(
  entries: IssueMetadataEntry[],
): Array<[string, IssueMetadataEntry[]]> {
  const groups: Array<[string, IssueMetadataEntry[]]> = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last !== undefined && last[0] === entry.namespace) last[1].push(entry);
    else groups.push([entry.namespace, [entry]]);
  }
  return groups;
}

/**
 * The human rendering shared by `metadata get` and `issue view --metadata`.
 * A value carrying newlines becomes an indented block under its key rather
 * than a table cell, which is the shape a stored JSON blob needs to stay
 * readable at all.
 */
export function renderMetadata(entries: IssueMetadataEntry[]): string {
  const lines: string[] = [];
  for (const [namespace, group] of groupByNamespace(entries)) {
    if (lines.length > 0) lines.push("");
    lines.push(`${namespace}:`);
    const flat = group.filter((e) => !e.value.includes("\n"));
    const blocks = group.filter((e) => e.value.includes("\n"));
    if (flat.length > 0) {
      lines.push(
        table(
          flat.map((e) => [
            `  ${e.key}`,
            e.value,
            `${personName(e.updated_by)} · ${relativeTime(e.updated_at)}`,
          ]),
        ),
      );
    }
    for (const entry of blocks) {
      lines.push(
        `  ${entry.key}  ${personName(entry.updated_by)} · ${relativeTime(entry.updated_at)}`,
      );
      for (const line of entry.value.split("\n")) lines.push(`    ${line}`);
    }
  }
  return lines.length === 0 ? "no metadata" : lines.join("\n");
}

/** One `ns/key=value`, for a list row where a whole table cannot fit. */
export function metadataInline(entries: IssueMetadataEntry[]): string {
  return entries
    .map((e) => `${e.namespace}/${e.key}=${e.value.replace(/\s+/g, " ")}`)
    .join(" ");
}

export class MetadataGetCommand extends ProjectCommand {
  static paths = [["metadata", "get"]];
  static usage = Command.Usage({
    description: "Read the metadata on an issue",
    details:
      "Grouped by namespace, one line per key with its value and who wrote " +
      "it when. Without `--namespace` every namespace is read. `--json` " +
      "prints the API response unchanged.",
    examples: [
      ["Everything on a card", "$0 metadata get 282"],
      ["Two namespaces", "$0 metadata get 282 --namespace orch,ci"],
    ],
  });

  number = Option.String({ required: true });
  namespace = Option.Array("--namespace,--ns", [], {
    description: "Namespace to read (repeatable, comma-splittable; * = all)",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const result = await client.getIssueMetadata(
      project,
      number,
      selectorOf(this.namespace),
    );
    this.output(result, () => renderMetadata(result.entries));
  }
}

export class MetadataNamespacesCommand extends ProjectCommand {
  static paths = [["metadata", "namespaces"]];
  static usage = Command.Usage({
    description: "List the metadata namespaces on an issue",
    details:
      "Names, how many keys each holds, and its newest write — no values.",
  });

  number = Option.String({ required: true });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const result = await client.listIssueMetadataNamespaces(project, number);
    this.output(result, () =>
      result.namespaces.length === 0
        ? "no metadata"
        : table(
            result.namespaces.map((n) => [
              n.namespace,
              `${n.keys} key${n.keys === 1 ? "" : "s"}`,
              relativeTime(n.updated_at),
            ]),
          ),
    );
  }
}

/** The compare-and-set flags of one write, resolved per key. */
type Expectations = Map<string, string | null>;

function expectationsOf(ifMatch: string[], ifAbsent: string[]): Expectations {
  const expected: Expectations = new Map();
  for (const raw of ifMatch) {
    const { key, value } = splitPair(raw, "--if-match");
    if (expected.has(key)) {
      throw new CliError(`two expectations for "${key}"`, "state one of them");
    }
    expected.set(key, value);
  }
  for (const raw of splitCommaList(ifAbsent)) {
    const key = checkKey(raw);
    if (expected.has(key)) {
      throw new CliError(`two expectations for "${key}"`, "state one of them");
    }
    // Deliberately a separate flag rather than `--if-match key=`: the empty
    // string is a legal value, so that spelling would fold "expected to be
    // empty" and "expected not to exist" into one.
    expected.set(key, null);
  }
  return expected;
}

abstract class MetadataWriteCommand extends ProjectCommand {
  /**
   * Sends the write, turning a failed expectation into exit code 1 and a
   * report of what is actually stored. Only that one code is caught: it is
   * the one that means "you lost a race, and here is what you lost it to",
   * and every other failure is still a failure.
   */
  protected async submit(
    client: TodouClient,
    project: string,
    number: number,
    entries: IssueMetadataWriteEntry[],
  ): Promise<number> {
    try {
      const result = await client.writeIssueMetadata(project, number, {
        entries,
      });
      this.output(result, () => renderMetadata(result.entries));
      return 0;
    } catch (error) {
      if (
        error instanceof TodouError &&
        error.code === "metadata_precondition"
      ) {
        const failed = (error.details as { failed?: unknown } | undefined)
          ?.failed;
        const lines = Array.isArray(failed)
          ? failed.map(
              (f: { namespace: string; key: string; current: string | null }) =>
                `${f.namespace}/${f.key} is ${f.current === null ? "not set" : JSON.stringify(f.current)}`,
            )
          : [error.message];
        // Nothing was written — the whole request is refused together — so
        // the caller can re-read, decide, and send the same command again.
        this.note(`nothing written; the expectation did not hold:`);
        for (const line of lines) this.note(`  ${line}`);
        return 1;
      }
      throw error;
    }
  }
}

export class MetadataSetCommand extends MetadataWriteCommand {
  static paths = [["metadata", "set"]];
  static usage = Command.Usage({
    description: "Write metadata keys on an issue",
    details:
      "Only the keys named are touched; everything else in the namespace " +
      "stays. Values come as `key=value` positionals, or one key at a time " +
      "with `--key` and `--value-file` for a value that carries newlines.\n\n" +
      "`--if-match key=value` and `--if-absent key` make the write a " +
      "compare-and-set: if any expectation fails the whole request is " +
      "refused, nothing is stored, the current values are printed and the " +
      "exit code is 1. They are separate flags because the empty string is " +
      'a legal value, so `--if-match key=` means "expected to be empty" ' +
      'and not "expected to be missing".\n\n' +
      "Writing a value that is already stored changes nothing at all: no " +
      "timestamp moves and no subscriber is woken, so replaying a state is " +
      "free.",
    examples: [
      ["Move a state", "$0 metadata set 282 --namespace orch phase=impl"],
      [
        "Claim a card, losing cleanly to whoever got there first",
        "$0 metadata set 282 --namespace orch owner=agent-1 --if-absent owner",
      ],
      [
        "A value from a file",
        "$0 metadata set 282 --namespace ci --key report --value-file ./out.json",
      ],
    ],
  });

  number = Option.String({ required: true });
  namespace = Option.String("--namespace,--ns", { required: true });
  pairs = Option.Rest();
  key = Option.String("--key", {
    description: "The single key to write, paired with --value-file",
  });
  valueFile = Option.String("--value-file", {
    description: "Read that key's value from a file, or `-` for stdin",
  });
  ifMatch = Option.Array("--if-match", [], {
    description: "Expect <key>=<value> to be the stored value (repeatable)",
  });
  ifAbsent = Option.Array("--if-absent", [], {
    description: "Expect <key> not to exist yet (repeatable)",
  });

  protected async run(client: TodouClient): Promise<number> {
    const namespace = checkNamespace(this.namespace);
    const usingFile = this.key !== undefined || this.valueFile !== undefined;
    if (usingFile && this.pairs.length > 0) {
      throw new CliError(
        "--key/--value-file and key=value positionals are two ways to say the same thing",
        "use one of them",
      );
    }
    if (usingFile && (this.key === undefined || this.valueFile === undefined)) {
      throw new CliError(
        "--key and --value-file go together",
        "todou metadata set <n> --namespace <ns> --key <key> --value-file <path|->",
      );
    }
    if (!usingFile && this.pairs.length === 0) {
      throw new CliError(
        "nothing to write",
        "pass key=value, or --key <key> --value-file <path|->",
      );
    }

    const written: Array<{ key: string; value: string }> = usingFile
      ? [
          {
            key: checkKey(this.key as string),
            value: await readBody({
              bodyFile: this.valueFile,
              stdin: this.context.stdin,
              isTTY: false,
              env: this.context.env,
              cwd: this.context.cwd,
            }),
          },
        ]
      : this.pairs.map((raw) => splitPair(raw, "metadata set"));

    const expected = expectationsOf(this.ifMatch, this.ifAbsent);
    const named = new Set(written.map((w) => w.key));
    for (const key of expected.keys()) {
      if (!named.has(key)) {
        throw new CliError(
          `--if-match/--if-absent names "${key}", which this command does not write`,
          "an expectation only guards a key the same request writes",
        );
      }
    }

    const { project, number } = await this.resolveIssueRef(client, this.number);
    return this.submit(
      client,
      project,
      number,
      written.map((w) => ({
        namespace,
        key: w.key,
        value: w.value,
        ...(expected.has(w.key)
          ? { if_match: expected.get(w.key) as string | null }
          : {}),
      })),
    );
  }
}

export class MetadataUnsetCommand extends MetadataWriteCommand {
  static paths = [["metadata", "unset"]];
  static usage = Command.Usage({
    description: "Delete metadata keys from an issue",
    details:
      "Deleting a key that is not there is not an error and changes " +
      "nothing. To clear a key while keeping it, write the empty string " +
      "instead: `metadata set <n> --namespace <ns> key=`.",
    examples: [
      ["Drop two keys", "$0 metadata unset 282 --namespace orch phase owner"],
    ],
  });

  number = Option.String({ required: true });
  namespace = Option.String("--namespace,--ns", { required: true });
  keys = Option.Rest({ required: 1 });

  protected async run(client: TodouClient): Promise<number> {
    const namespace = checkNamespace(this.namespace);
    const keys = splitCommaList(this.keys).map(checkKey);
    const { project, number } = await this.resolveIssueRef(client, this.number);
    return this.submit(
      client,
      project,
      number,
      keys.map((key) => ({ namespace, key, value: null })),
    );
  }
}
