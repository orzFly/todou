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

export const DirectUploadRequest = z.object({
  issue_number: z.number().int().positive(),
  filename: z.string().min(1),
  content_type: z.string(),
  size: z.number().int().positive(),
  /** base64 of the 32-byte SHA-256 digest; pinned into the presign if set. */
  sha256: z.string().length(44).optional(),
});
export type DirectUploadRequest = z.infer<typeof DirectUploadRequest>;

export const DirectUploadTicket = z.object({
  upload_id: Id,
  /** Presigned PUT URL, signed for the store's public endpoint. */
  url: z.string(),
  /** Headers the client must send verbatim with the PUT. */
  headers: z.record(z.string(), z.string()),
  expires_at: Timestamp,
});
export type DirectUploadTicket = z.infer<typeof DirectUploadTicket>;
