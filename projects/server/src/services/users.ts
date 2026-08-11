import type { Me, UserRef } from "@todou/shared";
import { eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { Db } from "../db/driver.ts";
import { users } from "../db/system-schema.ts";

type OwnerRef = { id: number; login: string } | null;

export function toUserRef(row: UserRow, owner: OwnerRef): UserRef {
  return {
    id: row.id,
    login: row.login,
    display_name: row.displayName,
    kind: row.kind,
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
        owner: null,
      });
    }
  }
  return result;
}
