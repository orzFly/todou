CREATE TABLE "project_mutes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "project_mutes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"muted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_mutes" ADD CONSTRAINT "project_mutes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_mutes_project_user_idx" ON "project_mutes" USING btree ("project_id","user_id");