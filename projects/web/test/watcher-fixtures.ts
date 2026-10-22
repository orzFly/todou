import type { UserRef, Watcher } from "@todou/shared";

export const agentUser = (id: number, name: string): UserRef => ({
  id,
  login: name.toLowerCase().replace(/ /g, "-"),
  display_name: name,
  kind: "machine",
  avatar_url: null,
  owner: null,
});

export const CLAUDE = agentUser(2, "Claude Agent");
export const BOT = agentUser(3, "Bot One");

let seq = 0;

/** One session; every call is a distinct session id, a minute apart. */
export const watcher = (who: UserRef, over: Partial<Watcher> = {}): Watcher => {
  seq += 1;
  return {
    user: who,
    agent_context: { agent: "claude-code", session_id: `s-${seq}` },
    kind: "watch",
    scope: "issue",
    since: `2026-10-22T10:${String(seq % 60).padStart(2, "0")}:00.000Z`,
    ...over,
  };
};
