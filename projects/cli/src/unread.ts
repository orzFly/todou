import type { TodouClient } from "@todou/shared";
import type { Env } from "./config.ts";
import {
  loadCliState,
  projectKey,
  projectState,
  saveCliState,
} from "./state.ts";

/**
 * Advances the local activity frontier past new foreign entries and returns
 * the numbers of issues with unread activity by other users. Best-effort:
 * a server without /activity or an unwritable state dir degrades to
 * whatever the local state already knows (usually nothing) — the command
 * itself must never fail because of markers.
 */
export async function refreshUnread(
  client: TodouClient,
  server: string,
  project: string,
  env: Env,
): Promise<Set<number>> {
  const state = loadCliState(env);
  const ps = projectState(state, projectKey(server, project));
  try {
    if (ps.frontier === undefined) {
      // First run: existing history is not "unread" — start from now.
      const tail = await client.getActivity(project, { last: true, limit: 1 });
      ps.frontier = tail.next_cursor ?? undefined;
    } else {
      const myId = (await client.me()).id;
      let after: string | undefined = ps.frontier;
      do {
        const page = await client.getActivity(project, {
          after,
          exclude_actor: myId,
          limit: 100,
        });
        for (const item of page.items) {
          const key = String(item.issue_number);
          const entry = ps.issues[key] ?? { unread: false };
          ps.issues[key] = entry;
          // Skip entries the user has already seen via `issue view`
          // (ISO timestamps compare correctly as strings).
          if (
            entry.last_seen_at === undefined ||
            entry.last_seen_at < item.created_at
          ) {
            entry.unread = true;
          }
        }
        after = page.next_cursor ?? undefined;
        if (after !== undefined) ps.frontier = after;
      } while (after);
    }
    saveCliState(state, env);
  } catch {
    // Older server, offline, etc. — markers just don't refresh this run.
  }
  return new Set(
    Object.entries(ps.issues)
      .filter(([, v]) => v.unread)
      .map(([k]) => Number(k)),
  );
}

/** `issue view` clears the marker and records how far the user has read. */
export function markSeen(
  server: string,
  project: string,
  number: number,
  lastSeenAt: string | undefined,
  env: Env,
): void {
  const state = loadCliState(env);
  const ps = projectState(state, projectKey(server, project));
  const prior = ps.issues[String(number)];
  ps.issues[String(number)] = {
    unread: false,
    last_seen_at: lastSeenAt ?? prior?.last_seen_at,
  };
  saveCliState(state, env);
}
