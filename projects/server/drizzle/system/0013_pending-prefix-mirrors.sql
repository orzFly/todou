CREATE TABLE "pending_prefix_mirrors" (
	"project_id" bigint PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"verified_generation" bigint DEFAULT 0 NOT NULL,
	"first_marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "pending_prefix_mirrors" ADD CONSTRAINT "pending_prefix_mirrors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_prefix_mirrors_due_idx" ON "pending_prefix_mirrors" USING btree ("next_attempt_at");