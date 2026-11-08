ALTER TABLE "cli_auth_requests" ADD COLUMN "requester_ip" text;--> statement-breakpoint
ALTER TABLE "cli_auth_requests" ADD COLUMN "requester_user_agent" text;