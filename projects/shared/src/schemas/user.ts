import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

export const UserKind = z.enum(["human", "machine"]);
export type UserKind = z.infer<typeof UserKind>;

export const Login = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits, and dashes");

/** Compact user reference embedded in issues, comments, events, chips. */
export const UserRef = z.object({
  id: Id,
  login: z.string(),
  display_name: z.string(),
  kind: UserKind,
  owner: z
    .object({ id: Id, login: z.string() })
    .nullable()
    .describe("Owning human for machine users"),
});
export type UserRef = z.infer<typeof UserRef>;

export const User = UserRef.extend({
  email: z.email().nullable(),
  is_instance_admin: z.boolean(),
  created_at: Timestamp,
});
export type User = z.infer<typeof User>;

export const Me = User;
export type Me = z.infer<typeof Me>;
