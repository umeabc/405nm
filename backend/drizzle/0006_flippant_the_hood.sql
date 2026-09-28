CREATE TABLE "import_task_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"url" text NOT NULL,
	"referer" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_id" uuid,
	"code" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"created_by" uuid,
	"input_url" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"account_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	"duplicated" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"error_code" text DEFAULT '' NOT NULL,
	"error_message" text DEFAULT '' NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sourcing_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid,
	"source" text NOT NULL,
	"label" text NOT NULL,
	"credentials" text DEFAULT '' NOT NULL,
	"proxy_url" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_status" text DEFAULT '' NOT NULL,
	"last_message" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_task_items" ADD CONSTRAINT "import_task_items_task_id_import_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."import_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_task_items" ADD CONSTRAINT "import_task_items_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD CONSTRAINT "import_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD CONSTRAINT "import_tasks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD CONSTRAINT "import_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_tasks" ADD CONSTRAINT "import_tasks_account_id_sourcing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."sourcing_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_accounts" ADD CONSTRAINT "sourcing_accounts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_accounts" ADD CONSTRAINT "sourcing_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_task_items_task_idx" ON "import_task_items" USING btree ("task_id","idx");--> statement-breakpoint
CREATE INDEX "import_task_items_status_idx" ON "import_task_items" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "import_tasks_project_idx" ON "import_tasks" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "import_tasks_claim_idx" ON "import_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "sourcing_accounts_source_idx" ON "sourcing_accounts" USING btree ("source","enabled");--> statement-breakpoint
CREATE INDEX "sourcing_accounts_team_idx" ON "sourcing_accounts" USING btree ("team_id");