import { randomBytes, randomInt } from "node:crypto";
import type {
  CliAuthApproveResult,
  CliAuthPollResult,
  CliAuthRequestCreated,
  CliAuthRequestCreateInput,
  CliAuthRequestInfo,
  CliAuthTarget,
} from "@todou/shared";
import { normalizeCliAuthCode } from "@todou/shared";
import { and, eq, lt } from "drizzle-orm";
import { hashToken, type UserRow } from "../auth/pat.ts";
import { uniqueViolation } from "../auth/provision.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { cliAuthRequests } from "../db/system-schema.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { createAgent, loadAgentForToken } from "./agents.ts";
import { issueToken } from "./tokens.ts";

/** Crockford base32: no I/L/O/U, so a code read aloud or retyped survives. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;
const CODE_ATTEMPTS = 5;

/**
 * Short enough that a forgotten terminal cannot leave an approvable request
 * lying around, long enough to walk to another machine. The CLI's own
 * timeout (5 minutes) sits well inside it.
 */
export const CLI_AUTH_TTL_SECONDS = 900;
export const CLI_AUTH_POLL_INTERVAL_SECONDS = 3;

export function generateCliAuthCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Creating a request needs no credentials — the caller is a CLI that has
 * none yet. What keeps that from being an open-ended store: rows expire
 * after 15 minutes, every create sweeps the expired ones out first, and a
 * row carries nothing but a name until someone authorizes it.
 */
export async function createCliAuthRequest(
  db: Db,
  input: CliAuthRequestCreateInput,
): Promise<CliAuthRequestCreated> {
  const now = new Date();
  await db.delete(cliAuthRequests).where(lt(cliAuthRequests.expiresAt, now));

  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + CLI_AUTH_TTL_SECONDS * 1000);
  for (let attempt = 1; ; attempt++) {
    const code = generateCliAuthCode();
    try {
      const inserted = await db
        .insert(cliAuthRequests)
        .values({
          code,
          pollSecretHash: hashToken(secret),
          name: input.name,
          expiresAt,
        })
        .returning({ id: cliAuthRequests.id });
      const id = inserted[0]?.id;
      if (id === undefined) throw new Error("cli auth insert returned no id");
      return {
        id,
        code,
        poll_secret: secret,
        interval: CLI_AUTH_POLL_INTERVAL_SECONDS,
        expires_in: CLI_AUTH_TTL_SECONDS,
      };
    } catch (err) {
      const clash = uniqueViolation(err) === "cli_auth_requests_code_idx";
      if (!clash || attempt === CODE_ATTEMPTS) throw err;
    }
  }
}

type RequestRow = typeof cliAuthRequests.$inferSelect;

/** Unknown, expired, and wrong-secret all answer alike: nothing to see. */
async function loadLive(db: Db, id: number): Promise<RequestRow> {
  const rows = await db
    .select()
    .from(cliAuthRequests)
    .where(eq(cliAuthRequests.id, id));
  const row = rows[0];
  if (!row || row.expiresAt <= new Date()) {
    throw new NotFoundError("cli auth request not found");
  }
  return row;
}

export async function pollCliAuthRequest(
  db: Db,
  id: number,
  pollSecret: string,
): Promise<CliAuthPollResult> {
  const row = await loadLive(db, id);
  if (row.pollSecretHash !== hashToken(pollSecret)) {
    throw new NotFoundError("cli auth request not found");
  }
  if (row.status === "pending") return { status: "pending" };

  // Deleting first is what makes the outcome collectable exactly once: two
  // polls racing here both see "approved", and only the one whose delete
  // removed the row goes on to mint.
  const consumed = await db
    .delete(cliAuthRequests)
    .where(eq(cliAuthRequests.id, row.id))
    .returning();
  const claimed = consumed[0];
  if (!claimed) throw new NotFoundError("cli auth request not found");
  if (claimed.status === "denied") return { status: "denied" };

  const userId = claimed.approvedUserId;
  if (userId === null) throw new Error("approved cli auth request has no user");
  const minted = await issueToken(db, userId, { name: claimed.name });
  return { status: "approved", token: minted.token };
}

export async function readCliAuthRequestByCode(
  db: Db,
  rawCode: string,
): Promise<CliAuthRequestInfo> {
  const rows = await db
    .select()
    .from(cliAuthRequests)
    .where(eq(cliAuthRequests.code, normalizeCliAuthCode(rawCode)));
  const row = rows[0];
  if (row?.status !== "pending" || row.expiresAt <= new Date()) {
    throw new NotFoundError("cli auth request not found");
  }
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
  };
}

async function loadPending(db: Db, id: number): Promise<RequestRow> {
  const row = await loadLive(db, id);
  if (row.status !== "pending") {
    throw new ConflictError("cli auth request is no longer pending");
  }
  return row;
}

/**
 * Records who the token will belong to; the PAT itself is minted later, when
 * the CLI polls for it. Resolving the target before claiming the row keeps a
 * doomed approval (a taken login, a disabled agent) from marking it used.
 */
export async function approveCliAuthRequest(
  ctx: AppContext,
  actor: UserRow,
  id: number,
  target: CliAuthTarget,
): Promise<CliAuthApproveResult> {
  const db = ctx.router.system();
  await loadPending(db, id);

  let userId: number;
  let agentId: number | null;
  switch (target.kind) {
    case "me":
      userId = actor.id;
      agentId = null;
      break;
    case "agent": {
      const agent = await loadAgentForToken(ctx, actor, target.id);
      userId = agent.id;
      agentId = agent.id;
      break;
    }
    case "new": {
      const agent = await createAgent(ctx, actor, {
        login: target.login,
        display_name: target.login,
      });
      userId = agent.id;
      agentId = agent.id;
      break;
    }
  }

  const updated = await db
    .update(cliAuthRequests)
    .set({ status: "approved", approvedUserId: userId, approvedById: actor.id })
    .where(
      and(eq(cliAuthRequests.id, id), eq(cliAuthRequests.status, "pending")),
    )
    .returning({ id: cliAuthRequests.id });
  if (updated.length === 0) {
    throw new ConflictError("cli auth request is no longer pending");
  }
  return { agent_id: agentId };
}

export async function denyCliAuthRequest(db: Db, id: number): Promise<void> {
  await loadPending(db, id);
  const updated = await db
    .update(cliAuthRequests)
    .set({ status: "denied" })
    .where(
      and(eq(cliAuthRequests.id, id), eq(cliAuthRequests.status, "pending")),
    )
    .returning({ id: cliAuthRequests.id });
  if (updated.length === 0) {
    throw new ConflictError("cli auth request is no longer pending");
  }
}
