import { join } from "node:path";
import type { AgentContext } from "@todou/shared";
import type { Env } from "../config.ts";
import type { Harness } from "./types.ts";

type SqliteModule = typeof import("node:sqlite");
type Database = InstanceType<SqliteModule["DatabaseSync"]>;

/**
 * Hermes Agent (nousresearch/hermes-agent). Gateway turns bridge the
 * HERMES_SESSION_* context vars into every child environment; the session
 * key (`agent:<agent>:<platform>:<chat_type>:<chat_id>`) is the durable
 * chat identity, so that is what session_id records. `_HERMES_GATEWAY=1`
 * marks the whole gateway process tree and catches keyless turns.
 * HERMES_HOME alone is NOT a signal: an ordinary shell may export it
 * permanently just to relocate hermes state.
 */
export const hermesAgent: Harness = {
  id: "hermes-agent",
  matches: (env) =>
    Boolean(env.HERMES_SESSION_KEY) || env._HERMES_GATEWAY === "1",
  context(env, home) {
    const context: AgentContext = { agent: "hermes-agent" };
    if (env.HERMES_SESSION_KEY) context.session_id = env.HERMES_SESSION_KEY;
    const model = detectHermesModel(env, home);
    if (model) context.model = model;
    return context;
  },
};

/**
 * Best-effort model lookup in `$HERMES_HOME/state.db`. Hermes exposes no
 * environment variable for the live model; the sessions table is a
 * hermes-internal, unofficial format that migrates freely — so every
 * failure (no node:sqlite builtin on older Node, unopenable database,
 * missing table/row, foreign shape) degrades to "no model", never an error.
 */
function detectHermesModel(env: Env, home: string): string | undefined {
  try {
    const sqlite = process.getBuiltinModule("node:sqlite") as
      | SqliteModule
      | undefined;
    if (!sqlite) return undefined;
    const db = new sqlite.DatabaseSync(
      join(env.HERMES_HOME || join(home, ".hermes"), "state.db"),
      { readOnly: true },
    );
    try {
      // `||`, not `??`: a gateway turn binds the session-id context var to the
      // empty string (its default — the gateway passes only the session key)
      // and hermes bridges explicitly-bound-empty values through to the child
      // env verbatim. Under `??` that empty string counts as present and
      // suppresses the routing lookup, so model would never resolve on exactly
      // the turns this detector exists for (T-120).
      const id =
        env.HERMES_SESSION_ID ||
        sessionIdFromRouting(db, env.HERMES_SESSION_KEY);
      if (!id) return undefined;
      const row = db.prepare("SELECT model FROM sessions WHERE id = ?").get(id);
      const model = row?.model;
      return typeof model === "string" && model !== "" ? model : undefined;
    } finally {
      db.close();
    }
  } catch {
    // Unreadable hermes state is never an error.
    return undefined;
  }
}

/**
 * A gateway turn always carries the session key but never a usable durable
 * session id; the routing index maps one to the other.
 */
function sessionIdFromRouting(
  db: Database,
  key: string | undefined,
): string | undefined {
  if (!key) return undefined;
  const row = db
    .prepare(
      "SELECT entry_json FROM gateway_routing WHERE session_key = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(key);
  if (typeof row?.entry_json !== "string") return undefined;
  const entry = JSON.parse(row.entry_json) as { session_id?: unknown };
  return typeof entry.session_id === "string" && entry.session_id !== ""
    ? entry.session_id
    : undefined;
}
