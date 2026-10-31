import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentContext } from "@todou/shared";
import type { Env } from "../config.ts";
import type { Harness } from "./types.ts";

/**
 * DeepSeek Harness (dsh). Every model shell call — bash and pwsh alike — runs
 * with a trusted `DSH_*` overlay rebuilt for that execution, and
 * `DSH_SESSION_ID` is the one fact on all of them: the id of the session whose
 * turn is calling us. `DSH_HOME` names the harness home the overlay came from,
 * so the session's record is addressed from the same place as its id.
 *
 * The model is not an environment variable. DSH keeps a small projection cache
 * per session for its desktop UI, and `modelSelection.lastUsed` there is the
 * pair the next request runs with — including after a mid-session switch. That
 * cache is an internal format that may move; every failure degrades to "less
 * metadata", never to an error, and never costs us the id the environment
 * already gave us.
 */
export const dsh = {
  id: "dsh",
  matches: (env) => Boolean(env.DSH_SESSION_ID),
  context({ env, home }) {
    const context: AgentContext = { agent: "dsh" };
    const sessionId = env.DSH_SESSION_ID;
    if (sessionId) context.session_id = sessionId;
    const model = modelForSession(env, sessionId, home);
    if (model) context.model = model;
    return context;
  },
} satisfies Harness;

function modelForSession(
  env: Env,
  sessionId: string | undefined,
  home: string,
): string | undefined {
  if (!sessionId) return undefined;
  // The id comes from the environment: refuse anything path-shaped.
  if (!/^[0-9a-zA-Z-]+$/.test(sessionId)) return undefined;
  // `||`, not `??`: an empty DSH_HOME is a shell that exported nothing useful,
  // not a home directory chosen relative to the filesystem root.
  const dshHome = env.DSH_HOME || join(home, ".dsh");
  try {
    const raw = readFileSync(
      join(
        dshHome,
        "storages",
        "session_projcache",
        "sessions",
        `${sessionId}.json`,
      ),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      record?: {
        rows?: {
          modelSelection?: {
            val?: { lastUsed?: { model?: unknown } };
          };
        };
      };
    };
    const model = parsed.record?.rows?.modelSelection?.val?.lastUsed?.model;
    return typeof model === "string" && model !== "" ? model : undefined;
  } catch {
    // An unreadable cache is never an error.
    return undefined;
  }
}
