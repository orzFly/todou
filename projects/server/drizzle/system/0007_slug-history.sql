CREATE TABLE "slug_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "slug_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slug_history" ADD CONSTRAINT "slug_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slug_history_slug_from_idx" ON "slug_history" USING btree ("slug","effective_from");--> statement-breakpoint
CREATE INDEX "slug_history_project_from_idx" ON "slug_history" USING btree ("project_id","effective_from");--> statement-breakpoint
-- Every project has held its current slug since it was created: without
-- this row the slug resolves only through the live projects table, and the
-- interval before the first rename would belong to nobody.
INSERT INTO "slug_history" ("project_id", "slug", "effective_from")
SELECT "id", "slug", "created_at" FROM "projects";