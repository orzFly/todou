import type { Me, PublicUser, UserRef } from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { projectMembers, users } from "../db/system-schema.ts";
import { NotFoundError } from "../errors.ts";

type OwnerRef = { id: number; login: string } | null;

function avatarUrlOf(row: UserRow): string | null {
  if (!row.avatarKey) return null;
  // Each upload gets a fresh storage key, so its tail works as a cache
  // buster: the URL changes exactly when the image does.
  const version = row.avatarKey.split("/").pop()?.slice(0, 8) ?? "0";
  return `/api/users/${row.id}/avatar?v=${version}`;
}

export function toUserRef(row: UserRow, owner: OwnerRef): UserRef {
  return {
    id: row.id,
    login: row.login,
    display_name: row.displayName,
    kind: row.kind,
    avatar_url: avatarUrlOf(row),
    owner,
  };
}

export function toMe(row: UserRow, owner: OwnerRef): Me {
  return {
    ...toUserRef(row, owner),
    email: row.email,
    is_instance_admin: row.isInstanceAdmin,
    created_at: row.createdAt.toISOString(),
  };
}

export async function ownerRefOf(db: Db, row: UserRow): Promise<OwnerRef> {
  if (row.ownerId === null) return null;
  const rows = await db
    .select({ id: users.id, login: users.login })
    .from(users)
    .where(eq(users.id, row.ownerId));
  return rows[0] ?? null;
}

/**
 * One account's public identity, by id or by login (T-373).
 *
 * Visibility is "shares at least one project with the caller", plus the
 * caller themself and instance admins. Someone who fails that and someone
 * who never existed answer identically — 404, same wording — so the
 * endpoint cannot be used to probe whether a login is real.
 */
export async function getPublicUser(
  ctx: AppContext,
  actor: UserRow,
  ref: string,
): Promise<PublicUser> {
  const system = ctx.router.system();
  const numeric = /^\d{1,15}$/.test(ref);
  const rows = await system
    .select()
    .from(users)
    .where(numeric ? eq(users.id, Number(ref)) : eq(users.login, ref));
  const row = rows[0];
  if (row === undefined) throw new NotFoundError("user not found");
  if (row.id !== actor.id && !actor.isInstanceAdmin) {
    // "Shares at least one project": two membership reads, no join needed —
    // the caller's set is small and the question is only whether the two
    // sets intersect at all.
    const mine = (
      await system
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, actor.id))
    ).map((m) => m.projectId);
    const shared =
      mine.length === 0
        ? []
        : await system
            .select({ projectId: projectMembers.projectId })
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.userId, row.id),
                inArray(projectMembers.projectId, mine),
              ),
            )
            .limit(1);
    // Same 404 for "cannot see" as for "does not exist": the endpoint must
    // not be usable to probe whether a login is real.
    if (shared.length === 0) throw new NotFoundError("user not found");
  }
  const owner = await ownerRefOf(system, row);
  return {
    ...toUserRef(row, owner),
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * Batch-resolve user references for timeline/issue enrichment. Unknown ids
 * become ghost refs so deleted accounts never break historical data.
 */
export async function getUserRefs(
  db: Db,
  ids: number[],
): Promise<Map<number, UserRef>> {
  const unique = [...new Set(ids)];
  const result = new Map<number, UserRef>();
  if (unique.length === 0) return result;

  const rows = await db.select().from(users).where(inArray(users.id, unique));
  const ownerIds = [
    ...new Set(
      rows.map((r) => r.ownerId).filter((v): v is number => v !== null),
    ),
  ];
  const owners = new Map<number, { id: number; login: string }>();
  if (ownerIds.length > 0) {
    for (const o of await db
      .select({ id: users.id, login: users.login })
      .from(users)
      .where(inArray(users.id, ownerIds))) {
      owners.set(o.id, o);
    }
  }
  for (const row of rows) {
    result.set(
      row.id,
      toUserRef(
        row,
        row.ownerId === null ? null : (owners.get(row.ownerId) ?? null),
      ),
    );
  }
  for (const id of unique) {
    if (!result.has(id)) {
      result.set(id, {
        id,
        login: "ghost",
        display_name: "Deleted user",
        kind: "human",
        avatar_url: null,
        owner: null,
      });
    }
  }
  return result;
}
