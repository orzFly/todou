CREATE TABLE "issue_reads" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "issue_reads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"issue_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "read_frontiers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "read_frontiers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"frontier_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_reads" ADD CONSTRAINT "issue_reads_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_reads_issue_user_idx" ON "issue_reads" USING btree ("issue_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "read_frontiers_project_user_idx" ON "read_frontiers" USING btree ("project_id","user_id");