import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Env } from "./config.ts";

const IssueReadState = z.object({
  unread: z.boolean().default(false),
  /** created_at of the newest entry seen via `issue view` (ISO, so string
   * comparison equals time comparison). Guards against re-marking an issue
   * unread from activity the user has already viewed. */
  last_seen_at: z.string().optional(),
});
export type IssueReadState = z.infer<typeof IssueReadState>;

const ProjectReadState = z.object({
  /** Project-activity cursor up to which foreign entries were scanned. */
  frontier: z.string().optional(),
  issues: z.record(z.string(), IssueReadState).default({}),
});
export type ProjectReadState = z.infer<typeof ProjectReadState>;

export const CliState = z.object({
  version: z.literal(1).default(1),
  /** Keyed by `${server}/${project}`. */
  projects: z.record(z.string(), ProjectReadState).default({}),
});
export type CliState = z.infer<typeof CliState>;

export function statePath(env: Env = process.env): string {
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "todou", "state.json");
}

/** Unreadable or corrupt state degrades to empty — markers are best-effort. */
export function loadCliState(env: Env = process.env): CliState {
  try {
    return CliState.parse(JSON.parse(readFileSync(statePath(env), "utf8")));
  } catch {
    return CliState.parse({});
  }
}

/** Best-effort too: an unwritable state dir must never fail the command. */
export function saveCliState(state: CliState, env: Env = process.env): void {
  try {
    const path = statePath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state)}\n`);
  } catch {
    // Read-only HOME (CI, sandboxes): commands still work, minus markers.
  }
}

export function projectKey(server: string, project: string): string {
  return `${server}/${project}`;
}

export function projectState(state: CliState, key: string): ProjectReadState {
  const existing = state.projects[key];
  if (existing) return existing;
  const fresh: ProjectReadState = { frontier: undefined, issues: {} };
  state.projects[key] = fresh;
  return fresh;
}
