import { join } from "node:path";
import type { AgentContext } from "@todou/shared";
import type { Env } from "../config.ts";
import type { Harness } from "./types.ts";

type SqliteModule = typeof import("node:sqlite");
type Database = InstanceType<SqliteModule["DatabaseSync"]>;

/**
 * Hermes Agent (nousresearch/hermes-agent). Every child process hermes spawns
 * — terminal tool, execute_code, the CLI's own `!` escape — is built through
 * one environment factory that stamps HERMES_REAL_HOME on it: the account
 * home, handed to a child whose HOME hermes may have relocated. That makes it
 * the one marker present on every surface (terminal CLI including over ssh,
 * messaging gateway, TUI, cron), and one a process outside hermes has nothing
 * to say with. HERMES_HOME is NOT a signal, and neither is HERMES_INTERACTIVE:
 * hermes documents both for users to export permanently, one to relocate its
 * state directory and one to allow interactive sudo prompts.
 *
 * The session variables are per-turn identity, not existence. Hermes binds
 * them task-locally and strips them from any subprocess it cannot attribute
 * to exactly one session, so an ordinary CLI turn may carry no session
 * variable at all (T-125) while a gateway turn carries only the key.
 */
export const hermesAgent = {
  id: "hermes-agent",
  matches: (env) =>
    Boolean(env.HERMES_REAL_HOME) ||
    Boolean(env.HERMES_SESSION_KEY) ||
    env._HERMES_GATEWAY === "1",
  context(env, home) {
    const context: AgentContext = { agent: "hermes-agent" };
    const session = detectHermesSession(env, home);
    if (session.id) context.session_id = session.id;
    if (session.model) context.model = session.model;
    return context;
  },
} satisfies Harness;

/**
 * The durable conversation id, which is both what `sessions.id` stores and
 * what `hermes --resume` takes. HERMES_SESSION_KEY is a coarser identity —
 * one chat lane (`agent:<agent>:<platform>:<chat_type>:<chat_id>`) spanning
 * every conversation ever opened in that chat — so it is a last resort rather
 * than an alternative: filing both shapes under one field would make a single
 * hermes session look like two. Hermes resolves its own HERMES_SESSION_ID in
 * this same order, key fallback included.
 *
 * The model rides along because it comes out of the row the id already names.
 * Hermes exposes no environment variable for the live model, and the sessions
 * table is a hermes-internal, unofficial format that migrates freely — so
 * every failure (no node:sqlite builtin on older Node, unopenable database,
 * missing table/row, foreign shape) degrades to "less metadata", never to an
 * error, and never costs us the id the environment already gave us.
 */
function detectHermesSession(
  env: Env,
  home: string,
): { id?: string; model?: string } {
  // `||`, not `??`: a gateway turn binds the session-id context var to the
  // empty string (its default — the gateway passes only the session key) and
  // hermes bridges explicitly-bound-empty values through to the child env
  // verbatim. Under `??` that empty string counts as present and suppresses
  // the routing lookup, so neither id nor model would ever resolve on exactly
  // the turns this detector exists for (T-120).
  let id = env.HERMES_SESSION_ID || undefined;
  let model: string | undefined;
  // Both rows the probe can read are keyed by an identity, so a turn that
  // carries neither leaves it nothing to ask — and opening the database is
  // not free: node:sqlite is still experimental on Node 22, where the open
  // prints a warning to stderr that would then ride on every single command.
  if (id || env.HERMES_SESSION_KEY) {
    try {
      const sqlite = process.getBuiltinModule("node:sqlite") as
        | SqliteModule
        | undefined;
      if (sqlite) {
        const db = new sqlite.DatabaseSync(
          join(env.HERMES_HOME || join(home, ".hermes"), "state.db"),
          { readOnly: true },
        );
        try {
          id ||= sessionIdFromRouting(db, env.HERMES_SESSION_KEY);
          model = id ? modelForSession(db, id) : undefined;
        } finally {
          db.close();
        }
      }
    } catch {
      // Unreadable hermes state is never an error.
    }
  }
  return { id: id || env.HERMES_SESSION_KEY || undefined, model };
}

function modelForSession(db: Database, id: string): string | undefined {
  const row = db.prepare("SELECT model FROM sessions WHERE id = ?").get(id);
  const model = row?.model;
  return typeof model === "string" && model !== "" ? model : undefined;
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
