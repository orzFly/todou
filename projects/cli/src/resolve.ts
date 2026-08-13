import type { Label, Status, TodouClient } from "@todou/shared";
import { CliError } from "./errors.ts";

/**
 * The project's current reference prefix for display spelling (#80).
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

export function byName<T extends { name: string }>(
  items: T[],
  name: string,
  kind: string,
): T {
  const found = items.find(
    (item) => item.name.toLowerCase() === name.toLowerCase(),
  );
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

export async function resolveLabel(
  client: TodouClient,
  project: string,
  name: string,
): Promise<Label> {
  return byName(await client.listLabels(project), name, "label");
}

export async function resolveLabels(
  client: TodouClient,
  project: string,
  names: string[],
): Promise<Label[]> {
  if (names.length === 0) return [];
  const labels = await client.listLabels(project);
  return names.map((name) => byName(labels, name, "label"));
}

/** Logins → user ids; the literal "me" resolves through GET /me. */
export async function resolveAssignees(
  client: TodouClient,
  project: string,
  logins: string[],
): Promise<number[]> {
  if (logins.length === 0) return [];
  const ids: number[] = [];
  const others = logins.filter((login) => login !== "me");
  const members = others.length > 0 ? await client.listMembers(project) : [];
  for (const login of logins) {
    if (login === "me") {
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
