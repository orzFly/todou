import { z } from "zod";
import { Timestamp } from "./common.ts";
import { Login, User } from "./user.ts";

/** A machine user. Owned by a human; authenticates only via PAT. */
export const Agent = User.extend({
  disabled_at: Timestamp.nullable(),
});
export type Agent = z.infer<typeof Agent>;

export const AgentCreateInput = z.object({
  login: Login,
  display_name: z.string().min(1).max(200),
});
export type AgentCreateInput = z.infer<typeof AgentCreateInput>;

export const AgentUpdateInput = z.object({
  display_name: z.string().min(1).max(200).optional(),
});
export type AgentUpdateInput = z.infer<typeof AgentUpdateInput>;

export const AgentListQuery = z.object({
  owner: z.enum(["me", "all"]).default("me"),
});
export type AgentListQuery = z.infer<typeof AgentListQuery>;
