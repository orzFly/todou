import type { Label, Status, TodouClient } from "@todou/shared";
import { canonicalizeLabelName, TodouError } from "@todou/shared";
import { CliError } from "./errors.ts";

/**
 * The project's current reference prefix for display spelling (T-80).
 * Best-effort on purpose: an old server (404) or a network blip must
 * never fail the command — the spelling just degrades to "#N".
 */
export async function fetchRefPrefix(
  client: TodouClient,
  project: string,
): Promise<string | null> {
  try {
    return (await client.getReferenceConfig(project)).format.prefix;
  } catch {
    return null;
  }
}

function findByName<T extends { name: string }>(
  items: T[],
  name: string,
): T | undefined {
  return items.find((item) => item.name.toLowerCase() === name.toLowerCase());
}

export function byName<T extends { name: string }>(
  items: T[],
  name: string,
  kind: string,
): T {
  const found = findByName(items, name);
  if (!found) {
    throw new CliError(
      `unknown ${kind} "${name}"`,
      `available: ${items.map((item) => item.name).join(", ") || "(none)"}`,
    );
  }
  return found;
}

export async function resolveStatus(
  client: TodouClient,
  project: string,
  name: string,
): Promise<Status> {
  return byName(await client.listStatuses(project), name, "status");
}

/** Several names off one listing, for filters that match any of them. */
export async function resolveStatuses(
  client: TodouClient,
  project: string,
  names: string[],
): Promise<Status[]> {
  if (names.length === 0) return [];
  const statuses = await client.listStatuses(project);
  return names.map((name) => byName(statuses, name, "status"));
}

/** `--status` override wins; otherwise the first closed-category status. */
export async function resolveClosedStatus(
  client: TodouClient,
  project: string,
  override?: string,
): Promise<Status> {
  const statuses = await client.listStatuses(project);
  if (override) return byName(statuses, override, "status");
  const closed = statuses
    .filter((status) => status.category === "closed")
    .sort((a, b) => a.position - b.position)[0];
  if (!closed) {
    throw new CliError(
      "project has no closed-category status",
      "pass --status <name> or create one in project settings",
    );
  }
  return closed;
}

/**
 * Every label name the CLI says out loud is canonicalized first (T-136).
 * The server stores the canonical spelling, so `'area:  cli'` has to match
 * the stored `area: cli` — otherwise a lookup misses, the write path tries
 * to create a label that already exists, and the user gets a bare 409.
 */
export async function resolveLabel(
  client: TodouClient,
  project: string,
  name: string,
): Promise<Label> {
  return byName(
    await client.listLabels(project),
    canonicalizeLabelName(name),
    "label",
  );
}

/** Strict: for filters and for `label edit/delete`, a miss is a typo. */
export async function resolveLabels(
  client: TodouClient,
  project: string,
  names: string[],
): Promise<Label[]> {
  if (names.length === 0) return [];
  const labels = await client.listLabels(project);
  return names.map((name) =>
    byName(labels, canonicalizeLabelName(name), "label"),
  );
}

/** Tailwind-500 hues, the family the seeded labels and statuses already use. */
const AUTO_LABEL_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

/**
 * A color for a label nobody picked one for. Derived from the name rather
 * than drawn at random (gh's answer to the same question) so that a set of
 * labels created one command at a time still comes out varied, the same
 * name lands on the same hue everywhere, and a test can assert the value.
 */
export function labelColorFor(name: string): string {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return AUTO_LABEL_COLORS[hash % AUTO_LABEL_COLORS.length] as string;
}

/**
 * Labels for a write: whatever the project does not have yet is created on
 * the spot and announced through `note` (T-135). Reads keep using
 * resolveLabels — a filter naming a label nobody defined is a typo, not a
 * request to invent one.
 */
export async function ensureLabels(
  client: TodouClient,
  project: string,
  names: string[],
  note: (line: string) => void,
): Promise<Label[]> {
  if (names.length === 0) return [];
  const known = await client.listLabels(project);
  const resolved: Label[] = [];
  for (const raw of names) {
    const name = canonicalizeLabelName(raw);
    const found = findByName(known, name);
    const label = found ?? (await createLabel(client, project, name, note));
    // Repeats within one command resolve against the fresh label too.
    if (found === undefined) known.push(label);
    resolved.push(label);
  }
  return resolved;
}

async function createLabel(
  client: TodouClient,
  project: string,
  name: string,
  note: (line: string) => void,
): Promise<Label> {
  try {
    const label = await client.createLabel(project, {
      name,
      color: labelColorFor(name),
    });
    note(
      `created label ${shellArg(label.name)} (${label.color}) · recolor: ` +
        `todou label edit ${shellArg(label.name)} -p ${project} --color '#rrggbb'`,
    );
    return label;
  } catch (error) {
    if (!(error instanceof TodouError)) throw error;
    if (error.status === 409) {
      // Lost the race with a sibling command creating the same label.
      const fresh = findByName(await client.listLabels(project), name);
      if (fresh) return fresh;
    }
    if (error.status === 403) {
      throw new CliError(
        `label "${name}" does not exist here, and creating one needs the admin role`,
        `ask a project admin for \`todou label create ${shellArg(name)} -p ${project}\`, ` +
          `or pick an existing one from \`todou label list -p ${project}\``,
      );
    }
    throw error;
  }
}

/** Single-quoted so a copy-pasted hint survives spaces and `:` in a name. */
export function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** gh spells the self-reference `@me`; both forms mean the current token. */
function isSelf(login: string): boolean {
  return login === "me" || login === "@me";
}

/** Logins → user ids; "me" (or gh's "@me") resolves through GET /me. */
export async function resolveAssignees(
  client: TodouClient,
  project: string,
  logins: string[],
): Promise<number[]> {
  if (logins.length === 0) return [];
  const ids: number[] = [];
  const others = logins.filter((login) => !isSelf(login));
  const members = others.length > 0 ? await client.listMembers(project) : [];
  for (const login of logins) {
    if (isSelf(login)) {
      ids.push((await client.me()).id);
      continue;
    }
    const member = members.find(
      (m) => m.user.login.toLowerCase() === login.toLowerCase(),
    );
    if (!member) {
      throw new CliError(
        `unknown assignee "${login}"`,
        `project members: ${
          members.map((m) => m.user.login).join(", ") || "(none)"
        }`,
      );
    }
    ids.push(member.user.id);
  }
  return ids;
}
