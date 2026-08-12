ALTER TABLE "comments" ADD COLUMN "component" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "open_questions" integer DEFAULT 0 NOT NULL;