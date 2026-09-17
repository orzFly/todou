CREATE TABLE "issue_mentions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "issue_mentions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"issue_id" bigint NOT NULL,
	"comment_id" bigint,
	"user_id" bigint NOT NULL,
	"actor_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_mentions" ADD CONSTRAINT "issue_mentions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_mentions" ADD CONSTRAINT "issue_mentions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_mentions_user_created_idx" ON "issue_mentions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_mentions_issue_idx" ON "issue_mentions" USING btree ("issue_id");