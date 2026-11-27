ALTER TABLE "issue_reads" ADD COLUMN "previous_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "read_frontiers" ADD COLUMN "previous_frontier_at" timestamp with time zone;