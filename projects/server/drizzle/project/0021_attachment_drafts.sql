ALTER TABLE "attachments" ADD COLUMN "draft" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_uploads" ADD COLUMN "draft" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "attachments_draft_created_idx" ON "attachments" USING btree ("created_at") WHERE "attachments"."draft";