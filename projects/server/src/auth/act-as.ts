import { ACT_AS_HEADER, LoginInput, type TokenActAs } from "@todou/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { users } from "../db/system-schema.ts";
import { UnauthorizedError } from "../errors.ts";
import { insertAgent } from "../services/users.ts";
import type { UserRow } from "./pat.ts";
import { uniqueViolation } from "./provision.ts";

/**
 * Whether `holder` may act as `agent`: the same people who may issue the
 * agent a token, so acting as it grants nothing they could not already get.
 * Disabled agents pass here on purpose — callers report that separately,
 * because only someone who passes this check should learn the reason.
 */
export function canActAs(holder: UserRow, agent: UserRow): boolean {
  return (
    agent.kind === "machine" &&
    (agent.ownerId === holder.id || holder.isInstanceAdmin)
  );
}

/**
 * The identity a Bearer request carrying {@link ACT_AS_HEADER} runs as.
 * "Does not exist", "not an agent" and "not yours" share one message:
 * telling them apart would only tell the caller what other accounts are
 * called.
 */
export async function resolveActAs(
  db: Db,
  holder: UserRow,
  actAs: TokenActAs,
  rawHeader: string,
): Promise<UserRow> {
  const login = rawHeader.trim();
  if (login === "") throw new UnauthorizedError(`${ACT_AS_HEADER} is empty`);
  if (holder.kind !== "human" || actAs === "off") {
    throw new UnauthorizedError("this token cannot act as an agent");
  }
  const notMine = () =>
    new UnauthorizedError(`no agent "${login}" this token can act as`);

  let agent = await findByLogin(db, login);
  if (!agent) {
    if (actAs !== "create") throw notMine();
    if (!LoginInput.safeParse(login).success) {
      throw new UnauthorizedError(`"${login}" is not a valid agent login`);
    }
    try {
      agent = await insertAgent(db, holder.id, login, login);
    } catch (error) {
      if (uniqueViolation(error) === null) throw error;
      // A concurrent request took the login first; judge whatever it made.
      agent = await findByLogin(db, login);
      if (!agent) throw error;
    }
  }
  if (!canActAs(holder, agent)) throw notMine();
  if (agent.disabledAt) {
    throw new UnauthorizedError(`agent "${login}" is disabled`);
  }
  return agent;
}

async function findByLogin(db: Db, login: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.login, login));
  return rows[0] ?? null;
}
