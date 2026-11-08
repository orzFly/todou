import { z } from "zod";
import { AgentContext } from "./agent-context.ts";
import { Timestamp } from "./common.ts";
import { ProjectSlug } from "./project.ts";
import { UserRef } from "./user.ts";

/** Which command holds the change-feed connection open (T-540). */
export const ConnectionWatcherKind = z.enum([
  "watch",
  "spec_wait",
  "question_wait",
]);
export type ConnectionWatcherKind = z.infer<typeof ConnectionWatcherKind>;

/** `marked` is a card-level mark set by `PUT …/watch`, held by no connection (T-669). */
export const WatcherKind = z.enum([...ConnectionWatcherKind.options, "marked"]);
export type WatcherKind = z.infer<typeof WatcherKind>;

/** `all_projects` is `todou watch --all-projects`, listed under every project its account can read. */
export const WatcherScope = z.enum(["project", "all_projects", "issue"]);
export type WatcherScope = z.infer<typeof WatcherScope>;

/**
 * One agent session holding a declared change-feed connection open. Only
 * connections that carry agent context are ever listed, so `agent_context`
 * is never null here.
 */
export const Watcher = z.object({
  user: UserRef,
  agent_context: AgentContext,
  kind: WatcherKind,
  scope: WatcherScope,
  since: Timestamp,
  /** Present exactly when `kind` is `marked`. */
  expires_at: Timestamp.optional(),
});
export type Watcher = z.infer<typeof Watcher>;

export const WatchersOverview = z.object({
  projects: z.record(ProjectSlug, z.array(Watcher)),
});
export type WatchersOverview = z.infer<typeof WatchersOverview>;

export const ProjectWatchers = z.object({
  project: z.array(Watcher),
  /** Keyed by card number as a decimal string; cards without watchers are absent. */
  issues: z.record(z.string(), z.array(Watcher)),
});
export type ProjectWatchers = z.infer<typeof ProjectWatchers>;

export const IssueWatchMarkInput = z.object({
  /** Defaults to 900. */
  ttl_seconds: z.number().int().min(1).max(3600).optional(),
});
export type IssueWatchMarkInput = z.infer<typeof IssueWatchMarkInput>;

export const IssueWatchMark = z.object({
  issue_number: z.number().int().positive(),
  /** When the mark was first set; renewals leave it alone. */
  since: Timestamp,
  expires_at: Timestamp,
});
export type IssueWatchMark = z.infer<typeof IssueWatchMark>;
