CREATE TABLE "issue_mutes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "issue_mutes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"issue_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"mode" text NOT NULL,
	"muted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_mutes" ADD CONSTRAINT "issue_mutes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_mutes_issue_user_idx" ON "issue_mutes" USING btree ("issue_id","user_id");