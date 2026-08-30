CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "comments_body_trgm_idx" ON "comments" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issues_title_trgm_idx" ON "issues" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issues_body_trgm_idx" ON "issues" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "spec_version_files_body_trgm_idx" ON "spec_version_files" USING gin ("body" gin_trgm_ops);