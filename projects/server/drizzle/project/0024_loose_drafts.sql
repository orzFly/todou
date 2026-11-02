ALTER TABLE "attachments" ALTER COLUMN "issue_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_uploads" ALTER COLUMN "issue_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_card_or_draft" CHECK ("attachments"."issue_id" IS NOT NULL OR "attachments"."draft");--> statement-breakpoint
ALTER TABLE "pending_uploads" ADD CONSTRAINT "pending_uploads_card_or_draft" CHECK ("pending_uploads"."issue_id" IS NOT NULL OR "pending_uploads"."draft");