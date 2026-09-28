CREATE TABLE "file_states" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"file_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor_id" uuid,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"width" integer DEFAULT 0 NOT NULL,
	"height" integer DEFAULT 0 NOT NULL,
	"md5" text DEFAULT '' NOT NULL,
	"sha256" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'sourced' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"parent_id" uuid,
	"old_revision_id" uuid,
	"activated" boolean DEFAULT true NOT NULL,
	"uploaded_by" uuid,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_role_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "project_role_permissions" (
	"project_role_id" uuid NOT NULL,
	"permission_code" text NOT NULL,
	CONSTRAINT "project_role_permissions_project_role_id_permission_code_pk" PRIMARY KEY("project_role_id","permission_code")
);
--> statement-breakpoint
CREATE TABLE "project_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"level" integer NOT NULL,
	"intro" text DEFAULT '' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"system_code" text,
	"source_template_id" uuid,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"intro" text DEFAULT '' NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"cover_file_id" uuid,
	"created_by" uuid,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"set_id" uuid,
	"serial" integer NOT NULL,
	"name" text NOT NULL,
	"intro" text DEFAULT '' NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"source_language" text DEFAULT 'ja' NOT NULL,
	"cover_file_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"language" text NOT NULL,
	"label" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "roles_project_idx";--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "team_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "project_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "file_states" ADD CONSTRAINT "file_states_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_states" ADD CONSTRAINT "file_states_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_role_id_project_roles_id_fk" FOREIGN KEY ("project_role_id") REFERENCES "public"."project_roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_role_permissions" ADD CONSTRAINT "project_role_permissions_project_role_id_project_roles_id_fk" FOREIGN KEY ("project_role_id") REFERENCES "public"."project_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_role_permissions" ADD CONSTRAINT "project_role_permissions_permission_code_permissions_code_fk" FOREIGN KEY ("permission_code") REFERENCES "public"."permissions"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_roles" ADD CONSTRAINT "project_roles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_roles" ADD CONSTRAINT "project_roles_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sets" ADD CONSTRAINT "project_sets_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sets" ADD CONSTRAINT "project_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_set_id_project_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."project_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_states_file_idx" ON "file_states" USING btree ("file_id","created_at");--> statement-breakpoint
CREATE INDEX "file_states_created_idx" ON "file_states" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "files_team_md5_idx" ON "files" USING btree ("team_id","md5");--> statement-breakpoint
CREATE INDEX "files_project_sort_idx" ON "files" USING btree ("project_id","sort_name");--> statement-breakpoint
CREATE INDEX "files_project_state_idx" ON "files" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "files_parent_idx" ON "files" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "files_legacy_id_idx" ON "files" USING btree ("legacy_id");--> statement-breakpoint
CREATE INDEX "project_members_user_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_roles_project_name_uq" ON "project_roles" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "project_roles_project_idx" ON "project_roles" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_sets_team_name_uq" ON "project_sets" USING btree ("team_id","name");--> statement-breakpoint
CREATE INDEX "project_sets_team_idx" ON "project_sets" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_team_serial_uq" ON "projects" USING btree ("team_id","serial");--> statement-breakpoint
CREATE INDEX "projects_team_idx" ON "projects" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "projects_set_idx" ON "projects" USING btree ("set_id");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("team_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "targets_project_language_uq" ON "targets" USING btree ("project_id","language");--> statement-breakpoint
CREATE INDEX "targets_project_idx" ON "targets" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "roles" DROP COLUMN "project_id";