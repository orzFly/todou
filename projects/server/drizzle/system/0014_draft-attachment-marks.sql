CREATE TABLE "draft_attachment_marks" (
	"project_id" bigint PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draft_attachment_marks" ADD CONSTRAINT "draft_attachment_marks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;