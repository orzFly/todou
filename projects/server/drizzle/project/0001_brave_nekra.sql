ALTER TABLE "comments" ADD COLUMN "agent_context" jsonb;--> statement-breakpoint
ALTER TABLE "issue_events" ADD COLUMN "agent_context" jsonb;