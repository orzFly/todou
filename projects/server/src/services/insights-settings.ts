import { createHash } from "node:crypto";
import type { PutSettings, Role, RoleEntry, Settings } from "@todou/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { insightsSettings, statuses } from "../db/project-schema.ts";
import { ConflictError, DomainError } from "../errors.ts";
import { requireCapability, routeInfoOf } from "./access.ts";

type StatusRow = typeof statuses.$inferSelect;
type SavedRow = typeof insightsSettings.$inferSelect;

const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);
const MAX_TRANSACTION_RETRIES = 2;

export function defaultInsightsRole(
  status: Pick<StatusRow, "name" | "category">,
): Role {
  if (status.name === "Invalid") return "excluded";
  if (status.name === "Shipped" || status.name === "Done") return "completed";
  return status.category === "closed" ? "completed" : "remaining";
}

function storedRole(value: unknown): Role | undefined {
  return value === "remaining" || value === "completed" || value === "excluded"
    ? value
    : undefined;
}

function orderedStatuses(rows: StatusRow[]): StatusRow[] {
  return [...rows].sort((a, b) => a.position - b.position || a.id - b.id);
}

export function statusDefinitionDigest(rows: StatusRow[]): string {
  const stable = [...rows]
    .sort((a, b) => a.id - b.id)
    .map(({ id, name, category, color, position }) => ({
      id,
      name,
      category,
      color,
      position,
    }));
  return createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("base64url");
}

function versionOf(revision: number, rows: StatusRow[]): string {
  return `${revision}.${statusDefinitionDigest(rows)}`;
}

function rolesOf(rows: StatusRow[], saved?: SavedRow): RoleEntry[] {
  const stored = saved?.roles ?? {};
  return orderedStatuses(rows).map((status) => ({
    status_id: status.id,
    name: status.name,
    category: status.category,
    color: status.color,
    position: status.position,
    role: storedRole(stored[String(status.id)]) ?? defaultInsightsRole(status),
  }));
}

export function insightsSettingsResponse(
  rows: StatusRow[],
  saved?: SavedRow,
): Settings {
  return {
    version: versionOf(saved?.revision ?? 0, rows),
    source: saved === undefined ? "default" : "saved",
    roles: rolesOf(rows, saved),
  };
}

async function statusRows(db: Db, projectId: number): Promise<StatusRow[]> {
  return db
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, projectId))
    .orderBy(asc(statuses.position), asc(statuses.id));
}

export async function getInsightsSettings(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<Settings> {
  const { project } = await requireCapability(ctx, actor, slug, "status.list");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const [rows, saved] = await Promise.all([
    statusRows(db, project.id),
    db
      .select()
      .from(insightsSettings)
      .where(eq(insightsSettings.projectId, project.id)),
  ]);
  return insightsSettingsResponse(rows, saved[0]);
}

function validation(message: string, details?: unknown): DomainError {
  return new DomainError(400, "validation_failed", message, details);
}

function validateCompleteMapping(
  rows: StatusRow[],
  input: PutSettings,
): Map<number, Role> {
  const expected = new Set(rows.map((row) => row.id));
  const supplied = new Map<number, Role>();
  for (const entry of input.roles) {
    if (supplied.has(entry.status_id)) {
      throw validation("roles contains duplicate status_id", {
        status_id: entry.status_id,
      });
    }
    if (!expected.has(entry.status_id)) {
      throw validation("roles contains a status outside this project", {
        status_id: entry.status_id,
      });
    }
    supplied.set(entry.status_id, entry.role);
  }
  const missing = rows
    .map((row) => row.id)
    .filter((statusId) => !supplied.has(statusId));
  if (missing.length > 0) {
    throw validation("roles must cover every current project status", {
      missing,
    });
  }
  return supplied;
}

function sqlStateOf(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    const candidate = cursor as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    cursor = candidate.cause;
  }
  return undefined;
}

export async function updateInsightsSettings(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: PutSettings,
): Promise<Settings> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "status.manage",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));

  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await db.transaction(async (tx) => {
        // This must be the transaction's first business statement: both the
        // initial insert race and later compare-and-swap use serializable rules.
        await tx.execute(
          sql.raw("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"),
        );
        await tx
          .insert(insightsSettings)
          .values({ projectId: project.id, revision: 0, roles: {} })
          .onConflictDoNothing();
        const savedRows = await tx
          .select()
          .from(insightsSettings)
          .where(eq(insightsSettings.projectId, project.id))
          .for("update");
        const saved = savedRows[0];
        if (!saved) throw new Error("insights settings row was not created");
        const currentStatuses = await statusRows(tx, project.id);
        const current = insightsSettingsResponse(currentStatuses, saved);
        if (input.version !== current.version) {
          throw new ConflictError(
            "insights settings changed — reload before saving",
            { current_version: current.version },
          );
        }
        const supplied = validateCompleteMapping(currentStatuses, input);
        const nextRoles = Object.fromEntries(
          currentStatuses.map((row) => [
            String(row.id),
            supplied.get(row.id) as Role,
          ]),
        );
        const unchanged = current.roles.every(
          (entry) => supplied.get(entry.status_id) === entry.role,
        );
        if (unchanged) return { response: current, changed: false };

        const updated = await tx
          .update(insightsSettings)
          .set({
            revision: sql`${insightsSettings.revision} + 1`,
            roles: nextRoles,
          })
          .where(
            and(
              eq(insightsSettings.projectId, project.id),
              eq(insightsSettings.revision, saved.revision),
            ),
          )
          .returning();
        const row = updated[0];
        if (!row) throw new Error("insights settings compare-and-swap failed");
        return {
          response: insightsSettingsResponse(currentStatuses, row),
          changed: true,
        };
      });

      if (result.changed) {
        ctx.bus.publish(project.id, {
          entity: "project",
          action: "updated",
          id: project.id,
        });
      }
      return result.response;
    } catch (error) {
      const code = sqlStateOf(error);
      if (!code || !RETRYABLE_SQLSTATES.has(code)) throw error;
      if (attempt >= MAX_TRANSACTION_RETRIES) {
        throw new DomainError(
          503,
          "service_unavailable",
          "insights settings are busy — reload and try again shortly",
        );
      }
    }
  }
}
