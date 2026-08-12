CREATE TABLE "spec_version_files" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "spec_version_files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"version_id" bigint NOT NULL,
	"path" text NOT NULL,
	"body" text NOT NULL,
	"size" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spec_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "spec_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"issue_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"author_id" bigint NOT NULL,
	"message" text,
	"agent_context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "resolved_by" bigint;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "spec_version" integer;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "spec_review_status" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "spec_unresolved_comments" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "spec_version_files" ADD CONSTRAINT "spec_version_files_version_id_spec_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."spec_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_versions" ADD CONSTRAINT "spec_versions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_version_files_version_path_idx" ON "spec_version_files" USING btree ("version_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "spec_versions_issue_number_idx" ON "spec_versions" USING btree ("project_id","issue_id","number");