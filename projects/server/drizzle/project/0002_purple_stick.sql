CREATE TABLE "revisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "revisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" bigint NOT NULL,
	"body" text NOT NULL,
	"actor_id" bigint NOT NULL,
	"agent_context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "body_edited_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "revisions_subject_idx" ON "revisions" USING btree ("project_id","subject_type","subject_id","id");