CREATE TABLE "project_access_denials" (
	"project_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"denied_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_access_denials_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "project_access_denials" ADD CONSTRAINT "project_access_denials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access_denials" ADD CONSTRAINT "project_access_denials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access_denials" ADD CONSTRAINT "project_access_denials_denied_by_users_id_fk" FOREIGN KEY ("denied_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_access_denials_user_id_idx" ON "project_access_denials" USING btree ("user_id");