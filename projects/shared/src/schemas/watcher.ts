import { z } from "zod";
import { AgentContext } from "./agent-context.ts";
import { Timestamp } from "./common.ts";
import { ProjectSlug } from "./project.ts";
import { UserRef } from "./user.ts";

/** Which command holds the change-feed connection open (T-540). */
export const WatcherKind = z.enum(["watch", "spec_wait", "question_wait"]);
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
