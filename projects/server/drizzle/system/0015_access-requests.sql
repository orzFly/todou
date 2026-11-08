CREATE TABLE "project_access_requests" (
	"project_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_access_requests_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "project_access_requests" ADD CONSTRAINT "project_access_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access_requests" ADD CONSTRAINT "project_access_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A denial recorded before this table existed answered a link the agent had
-- printed, so it counts as having asked: otherwise those rows would drop out
-- of the settings list while still in force, with nothing left to undo them.
INSERT INTO "project_access_requests" ("project_id", "user_id", "created_at")
SELECT "project_id", "user_id", "created_at" FROM "project_access_denials";
