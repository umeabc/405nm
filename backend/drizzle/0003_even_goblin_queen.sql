CREATE TABLE "file_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"role" text NOT NULL,
	"user_id" uuid,
	"display_name" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'auto' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"file_id" uuid,
	"actor_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"kind" text DEFAULT 'box' NOT NULL,
	"x" double precision DEFAULT 0 NOT NULL,
	"y" double precision DEFAULT 0 NOT NULL,
	"w" double precision DEFAULT 0 NOT NULL,
	"h" double precision DEFAULT 0 NOT NULL,
	"vertices" jsonb,
	"group_id" uuid,
	"order_index" integer DEFAULT 0 NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"style" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"user_id" uuid,
	"content" text DEFAULT '' NOT NULL,
	"proofread_content" text DEFAULT '' NOT NULL,
	"proofreader_id" uuid,
	"proofread_at" timestamp with time zone,
	"is_selected" boolean DEFAULT false NOT NULL,
	"machine_translated" boolean DEFAULT false NOT NULL,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_credits" ADD CONSTRAINT "file_credits_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_credits" ADD CONSTRAINT "file_credits_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_credits" ADD CONSTRAINT "file_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_credits" ADD CONSTRAINT "file_credits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_proofreader_id_users_id_fk" FOREIGN KEY ("proofreader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_credits_file_role_user_uq" ON "file_credits" USING btree ("file_id","role","user_id");--> statement-breakpoint
CREATE INDEX "file_credits_file_idx" ON "file_credits" USING btree ("file_id","created_at");--> statement-breakpoint
CREATE INDEX "file_credits_team_idx" ON "file_credits" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "sources_file_order_idx" ON "sources" USING btree ("file_id","order_index");--> statement-breakpoint
CREATE INDEX "sources_group_idx" ON "sources" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "sources_legacy_id_idx" ON "sources" USING btree ("legacy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "translations_source_target_user_uq" ON "translations" USING btree ("source_id","target_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "translations_one_selected_uq" ON "translations" USING btree ("source_id","target_id") WHERE "translations"."is_selected";--> statement-breakpoint
CREATE INDEX "translations_target_idx" ON "translations" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "translations_user_idx" ON "translations" USING btree ("user_id");