CREATE TABLE "pending_uploads" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pending_uploads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"issue_id" bigint NOT NULL,
	"uploader_id" bigint NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"declared_size" bigint NOT NULL,
	"sha256" text,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pending_uploads" ADD CONSTRAINT "pending_uploads_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_uploads_storage_key_idx" ON "pending_uploads" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "pending_uploads_expires_idx" ON "pending_uploads" USING btree ("expires_at");