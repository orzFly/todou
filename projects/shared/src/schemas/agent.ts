import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { MemberRole, ProjectBrief } from "./project.ts";
import { Login, User } from "./user.ts";

/** A machine user. Owned by a human; authenticates only via PAT. */
export const Agent = User.extend({
  disabled_at: Timestamp.nullable(),
});
export type Agent = z.infer<typeof Agent>;

export const AgentCreateInput = z.object({
  login: Login,
  display_name: z.string().trim().min(1).max(200),
});
export type AgentCreateInput = z.infer<typeof AgentCreateInput>;

export const AgentUpdateInput = z.object({
  login: Login.optional(),
  display_name: z.string().trim().min(1).max(200).optional(),
});
export type AgentUpdateInput = z.infer<typeof AgentUpdateInput>;

export const AgentListQuery = z.object({
  owner: z.enum(["me", "all"]).default("me"),
});
export type AgentListQuery = z.infer<typeof AgentListQuery>;

export const AgentMembership = z.object({
  agent_id: Id,
  project: ProjectBrief,
  role: MemberRole,
  created_at: Timestamp,
});
export type AgentMembership = z.infer<typeof AgentMembership>;

export const AgentMemberships = z.object({
  memberships: z.array(AgentMembership),
  /**
   * The projects the caller administers: both the candidate set for joining
   * and the test for which of the rows above may be edited.
   */
  manageable_projects: z.array(ProjectBrief),
});
export type AgentMemberships = z.infer<typeof AgentMemberships>;
