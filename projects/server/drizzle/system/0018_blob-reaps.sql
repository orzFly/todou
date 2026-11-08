CREATE TABLE "blob_reaps" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"project_id" bigint NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "blob_reaps_delete_after_idx" ON "blob_reaps" USING btree ("delete_after");--> statement-breakpoint
CREATE INDEX "blob_reaps_project_id_idx" ON "blob_reaps" USING btree ("project_id");