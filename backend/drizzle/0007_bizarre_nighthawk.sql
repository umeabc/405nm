CREATE TABLE "outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"language" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"storage_key" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"width" integer DEFAULT 0 NOT NULL,
	"height" integer DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outputs_file_language_version_uq" ON "outputs" USING btree ("file_id","language","version");--> statement-breakpoint
CREATE INDEX "outputs_file_idx" ON "outputs" USING btree ("file_id","created_at");