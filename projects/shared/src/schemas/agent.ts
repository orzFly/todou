import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { MemberRole, ProjectBrief } from "./project.ts";
import { LoginInput, User } from "./user.ts";

/** A machine user. Owned by a human; authenticates only via PAT. */
export const Agent = User.extend({
  disabled_at: Timestamp.nullable(),
});
export type Agent = z.infer<typeof Agent>;

export const AgentCreateInput = z.object({
  login: LoginInput,
  display_name: z.string().trim().min(1).max(200),
});
export type AgentCreateInput = z.infer<typeof AgentCreateInput>;

export const AgentUpdateInput = z.object({
  login: LoginInput.optional(),
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

/**
 * A project the caller may put their own machines into, with their effective
 * role there — which is the ceiling any of those machines may be given.
 *
 * Optional for the same reason as `Member.owner_role`, and it matters more
 * here: the client parses no schema at runtime (`client.ts` casts the decoded
 * JSON), so against a server from before this field neither the types nor the
 * runtime stops the page computing a ceiling from `undefined`. Missing means
 * not operable — the safe direction to degrade in.
 */
export const ManageableProject = ProjectBrief.extend({
  my_role: MemberRole.optional(),
});
export type ManageableProject = z.infer<typeof ManageableProject>;

export const AgentMemberships = z.object({
  memberships: z.array(AgentMembership),
  /**
   * The projects the caller holds any role in: both the candidate set for
   * joining and the test for which of the rows above may be edited.
   */
  manageable_projects: z.array(ManageableProject),
});
export type AgentMemberships = z.infer<typeof AgentMemberships>;
