CREATE TABLE "issue_metadata" (
	"project_id" bigint NOT NULL,
	"issue_id" bigint NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint NOT NULL,
	CONSTRAINT "issue_metadata_issue_id_namespace_key_pk" PRIMARY KEY("issue_id","namespace","key")
);
--> statement-breakpoint
ALTER TABLE "issue_metadata" ADD CONSTRAINT "issue_metadata_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_metadata_project_ns_key_idx" ON "issue_metadata" USING btree ("project_id","namespace","key");
