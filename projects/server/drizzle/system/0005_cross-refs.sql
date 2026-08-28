CREATE TABLE "ref_prefixes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_prefixes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" bigint NOT NULL,
	"prefix" text,
	"effective_from" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ref_prefixes" ADD CONSTRAINT "ref_prefixes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ref_prefixes_project_from_idx" ON "ref_prefixes" USING btree ("project_id","effective_from");--> statement-breakpoint
CREATE INDEX "ref_prefixes_prefix_idx" ON "ref_prefixes" USING btree ("prefix");--> statement-breakpoint
-- Each deployment's cross-reference grammar opens at the instant IT ran
-- this migration, so existing text on every instance keeps its meaning.
INSERT INTO "system_settings" ("key", "value") VALUES ('cross_refs_since', to_jsonb(now())) ON CONFLICT ("key") DO NOTHING;
