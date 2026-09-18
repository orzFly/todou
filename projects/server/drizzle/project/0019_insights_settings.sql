CREATE TABLE "insights_settings" (
	"project_id" bigint PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"roles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "insights_settings_revision_nonnegative" CHECK ("insights_settings"."revision" >= 0)
);
