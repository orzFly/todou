import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { UserRef } from "./user.ts";

export const Attachment = z.object({
  id: Id,
  filename: z.string(),
  content_type: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string(),
  uploader: UserRef,
  created_at: Timestamp,
});
export type Attachment = z.infer<typeof Attachment>;
