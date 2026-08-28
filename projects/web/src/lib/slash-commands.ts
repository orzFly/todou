import type { CommandInput, Label, Member, Status } from "@todou/shared";
import { canonicalizeLabelName } from "@todou/shared";

/**
 * Slash commands (T-161), the text half. A command is an ordinary draft line
 * that happens to parse: it lives in the document, deleting the line cancels
 * it, and typing `/close` by hand is exactly as good as picking it from the
 * panel — the panel is input assistance, not the carrier. Submitting strips
 * the recognized lines out of the body and compiles them to CommandInput.
 *
 * Everything here is pure so both the editor extension (highlighting, the
 * panel) and the composer (button label, submit) read the same verdict.
 */

export type CommandArgument = "none" | "status" | "label" | "member";

export type CommandDef = {
  /** The word after the slash. */
  name: string;
  argument: CommandArgument;
  /** One-line panel description, e.g. "→ Done". */
  detail: string;
  /** Summary for the submit button, e.g. "close" or "label area:web". */
  summarize: (argument: string) => string;
  compile: (argument: string) => CommandInput | null;
};

export type CommandRegistry = {
  commands: CommandDef[];
  byName: Map<string, CommandDef>;
  /** Argument candidates, for the panel's second stage. */
  statusNames: string[];
  labelNames: string[];
  memberLogins: string[];
};

/**
 * `In Progress` → `in-progress`. Lowercase, whitespace folded to hyphens,
 * everything a slash command cannot carry dropped: a status named `Won't
 * fix` still gets a typeable command.
 */
export function slugifyCommandName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Fixed names win over the ones derived from status names. A status called
 * "Close" would otherwise shadow `/close`, and which one the user meant is
 * unknowable; the loser stays reachable as `/status Close`.
 */
const RESERVED = new Set([
  "close",
  "reopen",
  "status",
  "label",
  "unlabel",
  "assign",
  "unassign",
]);

/** `--status` aside, the same rule the CLI's `resolveClosedStatus` follows. */
function firstClosedStatus(statuses: Status[]): Status | undefined {
  return statuses
    .filter((s) => s.category === "closed")
    .sort((a, b) => a.position - b.position)[0];
}

/** The project default when it is open, else the first open status. */
function defaultOpenStatus(statuses: Status[]): Status | undefined {
  const open = statuses
    .filter((s) => s.category === "open")
    .sort((a, b) => a.position - b.position);
  return open.find((s) => s.is_default) ?? open[0];
}

export function buildCommandRegistry({
  statuses,
  labels,
  members,
  me,
}: {
  statuses: Status[];
  labels: Label[];
  members: Member[];
  me: { id: number; login: string } | undefined;
}): CommandRegistry {
  const commands: CommandDef[] = [];

  const statusByName = (name: string): Status | undefined =>
    statuses.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  const statusCommand = (
    name: string,
    target: Status,
    summary: string,
  ): CommandDef => ({
    name,
    argument: "none",
    detail: `→ ${target.name}`,
    summarize: () => summary,
    compile: () => ({ type: "status", status_id: target.id }),
  });

  const closed = firstClosedStatus(statuses);
  if (closed !== undefined) {
    commands.push(statusCommand("close", closed, "close"));
  }
  const reopened = defaultOpenStatus(statuses);
  if (reopened !== undefined) {
    commands.push(statusCommand("reopen", reopened, "reopen"));
  }

  commands.push({
    name: "status",
    argument: "status",
    detail: "move to a status by name",
    summarize: (argument) =>
      `move to ${statusByName(argument)?.name ?? argument}`,
    compile: (argument) => {
      const status = statusByName(argument);
      return status === undefined
        ? null
        : { type: "status", status_id: status.id };
    },
  });

  const labelByName = (name: string): Label | undefined => {
    const wanted = canonicalizeLabelName(name).toLowerCase();
    return labels.find((l) => l.name.toLowerCase() === wanted);
  };
  for (const [name, type] of [
    ["label", "label_add"],
    ["unlabel", "label_remove"],
  ] as const) {
    commands.push({
      name,
      argument: "label",
      detail: name === "label" ? "add a label" : "remove a label",
      summarize: (argument) =>
        `${name} ${labelByName(argument)?.name ?? argument}`,
      compile: (argument) => {
        const label = labelByName(argument);
        return label === undefined ? null : { type, label_id: label.id };
      },
    });
  }

  // `me` is the CLI's spelling too, so muscle memory carries over.
  const memberByLogin = (login: string): { id: number } | undefined => {
    const wanted = login.trim().toLowerCase();
    if (wanted === "me" || wanted === "@me") return me;
    const bare = wanted.startsWith("@") ? wanted.slice(1) : wanted;
    return members.find((m) => m.user.login.toLowerCase() === bare)?.user;
  };
  for (const [name, type] of [
    ["assign", "assign"],
    ["unassign", "unassign"],
  ] as const) {
    commands.push({
      name,
      argument: "member",
      detail: name === "assign" ? "assign someone" : "remove an assignee",
      summarize: (argument) => `${name} ${argument.trim()}`,
      compile: (argument) => {
        const user = memberByLogin(argument);
        return user === undefined ? null : { type, user_id: user.id };
      },
    });
  }

  for (const status of statuses) {
    const name = slugifyCommandName(status.name);
    if (name === "" || RESERVED.has(name)) continue;
    if (commands.some((c) => c.name === name)) continue;
    commands.push(statusCommand(name, status, `move to ${status.name}`));
  }

  return {
    commands,
    byName: new Map(commands.map((c) => [c.name, c])),
    statusNames: statuses.map((s) => s.name),
    labelNames: labels.map((l) => l.name),
    memberLogins: [
      ...(me === undefined ? [] : ["me"]),
      ...members.map((m) => m.user.login),
    ],
  };
}

export type RecognizedLine = {
  command: CommandDef;
  /** Everything after the command word, trimmed; "" for no-argument commands. */
  argument: string;
  /** Null when the argument names nothing that exists. */
  compiled: CommandInput | null;
};

/**
 * Does this line, on its own, spell a command? Only whole lines count: a `/`
 * mid-sentence is prose, and prose is the default — an unknown `/clsoe` is
 * left exactly where it was typed rather than guessed at.
 */
export function recognizeCommandLine(
  line: string,
  registry: CommandRegistry,
): RecognizedLine | null {
  if (!line.startsWith("/")) return null;
  const match = /^\/([a-z0-9-]+)(?:[ \t]+([\s\S]*))?$/.exec(line.trimEnd());
  if (match === null) return null;
  const command = registry.byName.get(match[1] as string);
  if (command === undefined) return null;
  // The argument is the rest of the line, so label names with spaces need no
  // quoting; a no-argument command with trailing words is not that command.
  const argument = (match[2] ?? "").trim();
  if (command.argument === "none" && argument !== "") return null;
  if (command.argument !== "none" && argument === "") return null;
  return { command, argument, compiled: command.compile(argument) };
}

export type ParsedDraft = {
  /** The draft with every recognized command line removed. */
  body: string;
  commands: CommandInput[];
  /** Recognized but unresolvable — a label or member that does not exist. */
  invalid: { line: string; reason: string }[];
  /** Submit-button material: one summary per recognized command, in order. */
  summaries: string[];
};

/**
 * Which lines a fenced code block covers. Same line-based rule as the
 * server's `stripMarkdownCode`, for the same reason: 4-space code blocks
 * cannot be told from list continuations without a full markdown parse.
 */
function fencedLines(lines: string[]): boolean[] {
  const inCode = lines.map(() => false);
  let fence: { char: string; len: number } | null = null;
  for (const [i, line] of lines.entries()) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open?.[1] !== undefined) {
      const char = open[1][0] as string;
      const len = open[1].length;
      if (fence === null) {
        fence = { char, len };
        inCode[i] = true;
        continue;
      }
      if (char === fence.char && len >= fence.len) {
        fence = null;
        inCode[i] = true;
        continue;
      }
    }
    if (fence !== null) inCode[i] = true;
  }
  return inCode;
}

/** Line indices (0-based) that carry a recognized command. */
export function commandLinesOf(
  text: string,
  registry: CommandRegistry,
): Map<number, RecognizedLine> {
  const lines = text.split("\n");
  const inCode = fencedLines(lines);
  const found = new Map<number, RecognizedLine>();
  for (const [i, line] of lines.entries()) {
    if (inCode[i]) continue;
    const recognized = recognizeCommandLine(line, registry);
    if (recognized !== null) found.set(i, recognized);
  }
  return found;
}

export function parseCommandLines(
  text: string,
  registry: CommandRegistry,
): ParsedDraft {
  const lines = text.split("\n");
  const found = commandLinesOf(text, registry);
  const commands: CommandInput[] = [];
  const invalid: { line: string; reason: string }[] = [];
  const summaries: string[] = [];
  const kept: string[] = [];

  for (const [i, line] of lines.entries()) {
    const recognized = found.get(i);
    if (recognized === undefined) {
      kept.push(line);
      continue;
    }
    if (recognized.compiled === null) {
      const kind = recognized.command.argument;
      invalid.push({
        line: line.trim(),
        reason:
          kind === "label"
            ? `no label named "${recognized.argument}"`
            : kind === "member"
              ? `no member named "${recognized.argument}"`
              : kind === "status"
                ? `no status named "${recognized.argument}"`
                : "this command has no target in this project",
      });
      continue;
    }
    commands.push(recognized.compiled);
    summaries.push(recognized.command.summarize(recognized.argument));
  }

  return { body: kept.join("\n").trim(), commands, invalid, summaries };
}

/** "close" / "close and label bug" — the tail of the submit button's label. */
export function summarizeCommands(summaries: string[]): string {
  if (summaries.length <= 1) return summaries.join("");
  return `${summaries.slice(0, -1).join(", ")} and ${summaries.at(-1)}`;
}
