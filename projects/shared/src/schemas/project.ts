import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { UserRef } from "./user.ts";

export const ProjectSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits, and dashes");

export const Project = z.object({
  id: Id,
  slug: ProjectSlug,
  name: z.string(),
  description: z.string(),
  created_at: Timestamp,
});
export type Project = z.infer<typeof Project>;

export const ProjectCreateInput = z.object({
  slug: ProjectSlug,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(""),
});
export type ProjectCreateInput = z.infer<typeof ProjectCreateInput>;

export const ProjectUpdateInput = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
});
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateInput>;

export const MemberRole = z.enum(["admin", "writer", "reader"]);
export type MemberRole = z.infer<typeof MemberRole>;

export const Member = z.object({
  user: UserRef,
  role: MemberRole,
  created_at: Timestamp,
});
export type Member = z.infer<typeof Member>;

export const MemberSetInput = z.object({
  role: MemberRole,
});
export type MemberSetInput = z.infer<typeof MemberSetInput>;

export const StatusCategory = z.enum(["open", "closed"]);
export type StatusCategory = z.infer<typeof StatusCategory>;

const ColorHex = z.string().regex(/^#[0-9a-f]{6}$/i);

export const Status = z.object({
  id: Id,
  name: z.string(),
  category: StatusCategory,
  color: ColorHex,
  position: z.number().int(),
});
export type Status = z.infer<typeof Status>;

export const StatusCreateInput = z.object({
  name: z.string().min(1).max(60),
  category: StatusCategory,
  color: ColorHex.default("#6b7280"),
  position: z.number().int().optional(),
});
export type StatusCreateInput = z.infer<typeof StatusCreateInput>;

export const StatusUpdateInput = z.object({
  name: z.string().min(1).max(60).optional(),
  category: StatusCategory.optional(),
  color: ColorHex.optional(),
  position: z.number().int().optional(),
});
export type StatusUpdateInput = z.infer<typeof StatusUpdateInput>;

export const Label = z.object({
  id: Id,
  name: z.string(),
  color: ColorHex,
});
export type Label = z.infer<typeof Label>;

export const LabelCreateInput = z.object({
  name: z.string().min(1).max(60),
  color: ColorHex.default("#3b82f6"),
});
export type LabelCreateInput = z.infer<typeof LabelCreateInput>;

export const LabelUpdateInput = z.object({
  name: z.string().min(1).max(60).optional(),
  color: ColorHex.optional(),
});
export type LabelUpdateInput = z.infer<typeof LabelUpdateInput>;
