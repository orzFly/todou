import type { AgentContext } from "@todou/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { revisions } from "../db/project-schema.ts";

export type RevisionSubjectType =
  (typeof revisions.$inferSelect)["subjectType"];

/**
 * Record one content-changing edit: the caller has already established
 * that the new text differs and passes the superseded (pre-edit) body.
 * Runs on the caller's transaction so the snapshot and the content update
 * commit together.
 */
export async function recordRevision(
  db: Db,
  input: {
    projectId: number;
    subjectType: RevisionSubjectType;
    subjectId: number;
    body: string;
    actorId: number;
    agentContext: AgentContext | null;
  },
): Promise<void> {
  await db.insert(revisions).values(input);
}

/** Revisions have no FK to their subject; owning services cascade by hand. */
export async function deleteRevisionsFor(
  db: Db,
  projectId: number,
  subjectType: RevisionSubjectType,
  subjectId: number,
): Promise<void> {
  await db
    .delete(revisions)
    .where(
      and(
        eq(revisions.projectId, projectId),
        eq(revisions.subjectType, subjectType),
        eq(revisions.subjectId, subjectId),
      ),
    );
}
