CREATE TABLE "issue_blocks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "issue_blocks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" text DEFAULT 'blocks' NOT NULL,
	"blocker_project_id" bigint NOT NULL,
	"blocker_number" bigint NOT NULL,
	"blocked_project_id" bigint NOT NULL,
	"blocked_number" bigint NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_notified_at" timestamp with time zone,
	"blocker_deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "issue_blocks" ADD CONSTRAINT "issue_blocks_blocker_project_id_projects_id_fk" FOREIGN KEY ("blocker_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_blocks" ADD CONSTRAINT "issue_blocks_blocked_project_id_projects_id_fk" FOREIGN KEY ("blocked_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_blocks_edge_idx" ON "issue_blocks" USING btree ("blocker_project_id","blocker_number","blocked_project_id","blocked_number");--> statement-breakpoint
CREATE INDEX "issue_blocks_blocked_idx" ON "issue_blocks" USING btree ("blocked_project_id","blocked_number");--> statement-breakpoint
CREATE INDEX "issue_blocks_blocker_idx" ON "issue_blocks" USING btree ("blocker_project_id","blocker_number");