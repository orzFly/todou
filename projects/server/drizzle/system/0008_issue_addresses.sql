CREATE TABLE "issue_addresses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "issue_addresses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"lineage" bigint NOT NULL,
	"project_id" bigint NOT NULL,
	"number" bigint NOT NULL,
	"current_project_id" bigint NOT NULL,
	"current_number" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_moves" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "issue_moves_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"lineage" bigint,
	"move_token" text NOT NULL,
	"from_project_id" bigint NOT NULL,
	"from_number" bigint NOT NULL,
	"to_project_id" bigint NOT NULL,
	"to_number" bigint,
	"actor_id" bigint NOT NULL,
	"moved_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "moved_ids" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "moved_ids_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"project_id" bigint NOT NULL,
	"ref_id" bigint NOT NULL,
	"current_project_id" bigint NOT NULL,
	"current_id" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_moves" ADD CONSTRAINT "issue_moves_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_addresses_project_number_idx" ON "issue_addresses" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_addresses_lineage_project_idx" ON "issue_addresses" USING btree ("lineage","project_id");--> statement-breakpoint
CREATE INDEX "issue_addresses_lineage_idx" ON "issue_addresses" USING btree ("lineage");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_moves_token_idx" ON "issue_moves" USING btree ("move_token");--> statement-breakpoint
CREATE INDEX "issue_moves_state_idx" ON "issue_moves" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "moved_ids_kind_project_ref_idx" ON "moved_ids" USING btree ("kind","project_id","ref_id");--> statement-breakpoint
CREATE INDEX "moved_ids_kind_current_idx" ON "moved_ids" USING btree ("kind","current_project_id","current_id");