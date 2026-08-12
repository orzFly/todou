import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/auth/pat.ts";
import type { Db } from "../src/db/driver.ts";
import type { DbRouter } from "../src/db/router.ts";
import { sessions, tokens, users } from "../src/db/system-schema.ts";
import {
  startHousekeeping,
  sweepAuthRows,
} from "../src/services/housekeeping.ts";
import { makeRouter } from "./helpers.ts";

const HOUR_MS = 60 * 60 * 1000;

let router: DbRouter;
let db: Db;
let userId: number;

beforeAll(async () => {
  ({ router } = await makeRouter());
  db = router.system();
  const inserted = await db
    .insert(users)
    .values({ kind: "human", login: "sweep-user", displayName: "Sweep User" })
    .returning({ id: users.id });
  const row = inserted[0];
  if (!row) throw new Error("user insert returned no row");
  userId = row.id;
});

afterAll(async () => {
  await router.close();
});

let seq = 0;
const uniqueHash = (tag: string) => hashToken(`${tag}-${seq++}`);

function addSession(expiresAt: Date) {
  return db
    .insert(sessions)
    .values({ tokenHash: uniqueHash("session"), userId, expiresAt })
    .returning({ id: sessions.id })
    .then((rows) => rows[0]?.id);
}

function addToken(opts: { expiresAt?: Date; revokedAt?: Date; name: string }) {
  return db
    .insert(tokens)
    .values({
      userId,
      name: opts.name,
      tokenHash: uniqueHash("token"),
      prefix: "todou_pat_test",
      expiresAt: opts.expiresAt ?? null,
      revokedAt: opts.revokedAt ?? null,
    })
    .returning({ id: tokens.id })
    .then((rows) => rows[0]?.id);
}

async function remainingIds() {
  const sessionRows = await db.select({ id: sessions.id }).from(sessions);
  const tokenRows = await db.select({ id: tokens.id }).from(tokens);
  return {
    sessions: sessionRows.map((r) => r.id),
    tokens: tokenRows.map((r) => r.id),
  };
}

describe("sweepAuthRows", () => {
  it("purges only dead rows, and a second run finds nothing", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - HOUR_MS);
    const future = new Date(now.getTime() + HOUR_MS);

    const expiredSession = await addSession(past);
    const liveSession = await addSession(future);
    const revokedToken = await addToken({ name: "revoked", revokedAt: past });
    const expiredToken = await addToken({ name: "expired", expiresAt: past });
    const foreverToken = await addToken({ name: "forever" });
    const futureToken = await addToken({ name: "future", expiresAt: future });

    const swept = await sweepAuthRows(db, now);
    expect(swept).toEqual({ sessions: 1, tokens: 2 });

    const left = await remainingIds();
    expect(left.sessions).toContain(liveSession);
    expect(left.sessions).not.toContain(expiredSession);
    expect(left.tokens).toEqual(
      expect.arrayContaining([foreverToken, futureToken]),
    );
    expect(left.tokens).not.toContain(revokedToken);
    expect(left.tokens).not.toContain(expiredToken);

    const again = await sweepAuthRows(db, now);
    expect(again).toEqual({ sessions: 0, tokens: 0 });
    expect(await remainingIds()).toEqual(left);
  });

  it("treats a token both expired and revoked as one dead row", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - HOUR_MS);
    await addToken({ name: "doubly-dead", expiresAt: past, revokedAt: past });
    const swept = await sweepAuthRows(db, now);
    expect(swept.tokens).toBe(1);
  });
});

describe("startHousekeeping", () => {
  it("sweeps immediately on start and stops cleanly", async () => {
    const past = new Date(Date.now() - HOUR_MS);
    const dead = await addSession(past);

    // Interval far in the future: only the immediate startup sweep runs.
    const stop = startHousekeeping(db, 24 * HOUR_MS);
    try {
      await vi.waitFor(async () => {
        expect((await remainingIds()).sessions).not.toContain(dead);
      });
    } finally {
      stop();
    }
  });
});
