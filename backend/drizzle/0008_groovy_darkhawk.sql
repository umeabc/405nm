CREATE TABLE "credit_directory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"handle" text NOT NULL,
	"platform_uid" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"platform" text DEFAULT 'bilibili' NOT NULL,
	"label" text NOT NULL,
	"credentials" text DEFAULT '' NOT NULL,
	"platform_uid" text DEFAULT '' NOT NULL,
	"platform_name" text DEFAULT '' NOT NULL,
	"avatar_url" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cookie_status" text DEFAULT 'unknown' NOT NULL,
	"cookie_checked_at" timestamp with time zone,
	"cookie_message" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "publish_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid,
	"language" text DEFAULT '' NOT NULL,
	"account_id" uuid,
	"created_by" uuid,
	"idempotency_key" text NOT NULL,
	"kind" text DEFAULT '原创' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"topic" jsonb,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"slots" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"external_id" text DEFAULT '' NOT NULL,
	"external_url" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "publish_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"max_images" integer DEFAULT 9 NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_directory" ADD CONSTRAINT "credit_directory_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_directory" ADD CONSTRAINT "credit_directory_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_accounts" ADD CONSTRAINT "publish_accounts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_accounts" ADD CONSTRAINT "publish_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_job_id_publish_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."publish_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_account_id_publish_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."publish_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_templates" ADD CONSTRAINT "publish_templates_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_templates" ADD CONSTRAINT "publish_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_directory_team_handle_uq" ON "credit_directory" USING btree ("team_id","handle");--> statement-breakpoint
CREATE INDEX "credit_directory_team_idx" ON "credit_directory" USING btree ("team_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_accounts_team_label_uq" ON "publish_accounts" USING btree ("team_id","label");--> statement-breakpoint
CREATE INDEX "publish_accounts_team_idx" ON "publish_accounts" USING btree ("team_id","enabled");--> statement-breakpoint
CREATE INDEX "publish_attempts_job_idx" ON "publish_attempts" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "publish_attempts_inflight_idx" ON "publish_attempts" USING btree ("status","phase");--> statement-breakpoint
CREATE INDEX "publish_jobs_claim_idx" ON "publish_jobs" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "publish_jobs_team_idx" ON "publish_jobs" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "publish_jobs_project_idx" ON "publish_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_templates_team_name_uq" ON "publish_templates" USING btree ("team_id","name");