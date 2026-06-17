CREATE TYPE "public"."health_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."node_status" AS ENUM('online', 'offline', 'degraded', 'recording', 'alerting');--> statement-breakpoint
CREATE TYPE "public"."recording_source" AS ENUM('ad_hoc', 'schedule');--> statement-breakpoint
CREATE TYPE "public"."recording_status" AS ENUM('queued', 'recording', 'completed', 'failed', 'cached', 'uploaded');--> statement-breakpoint
CREATE TABLE "audio_channels" (
	"alias" varchar(160) NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_index" integer NOT NULL,
	"interface_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audio_interfaces" (
	"alias" varchar(160) NOT NULL,
	"backend" varchar(40) NOT NULL,
	"channel_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"sample_rates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"system_name" varchar(255) NOT NULL,
	"system_ref" varchar(255) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"action" varchar(160) NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" varchar(160),
	"target_type" varchar(160)
);
--> statement-breakpoint
CREATE TABLE "health_events" (
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid,
	"opened_at" timestamp with time zone NOT NULL,
	"recording_id" uuid,
	"resolved_at" timestamp with time zone,
	"schedule_id" uuid,
	"severity" "health_severity" NOT NULL,
	"type" varchar(160) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"agent_version" varchar(80) NOT NULL,
	"alias" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hostname" varchar(255) NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"location" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"network" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"status" "node_status" DEFAULT 'offline' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"description" text,
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recording_profiles" (
	"bitrate_kbps" integer NOT NULL,
	"channel_mode" varchar(64) NOT NULL,
	"codec" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"silence_detection_enabled" boolean DEFAULT false NOT NULL,
	"silence_skip_enabled" boolean DEFAULT false NOT NULL,
	"vbr" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"cache_path" text,
	"checksum" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"folder" text NOT NULL,
	"health_status" varchar(32) DEFAULT 'unknown' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"name" text NOT NULL,
	"node_id" uuid,
	"recorded_at" timestamp with time zone NOT NULL,
	"schedule_id" uuid,
	"source" "recording_source" NOT NULL,
	"status" "recording_status" NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"permission_id" varchar(120) NOT NULL,
	"role_id" varchar(64) NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"description" text,
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"folder_template" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"node_id" uuid,
	"recurrence" jsonb NOT NULL,
	"recording_profile_id" uuid,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timezone" varchar(80) NOT NULL,
	"title_template" text NOT NULL,
	"watchdog_policy_id" uuid
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"role_id" varchar(64) NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" varchar(320) NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"password_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "watchdog_policies" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audio_channels" ADD CONSTRAINT "audio_channels_interface_id_audio_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."audio_interfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_interfaces" ADD CONSTRAINT "audio_interfaces_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_events" ADD CONSTRAINT "health_events_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_events" ADD CONSTRAINT "health_events_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_events" ADD CONSTRAINT "health_events_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_recording_profile_id_recording_profiles_id_fk" FOREIGN KEY ("recording_profile_id") REFERENCES "public"."recording_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_watchdog_policy_id_watchdog_policies_id_fk" FOREIGN KEY ("watchdog_policy_id") REFERENCES "public"."watchdog_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audio_channels_interface_idx" ON "audio_channels" USING btree ("interface_id");--> statement-breakpoint
CREATE INDEX "audio_interfaces_node_idx" ON "audio_interfaces" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "health_events_node_idx" ON "health_events" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "health_events_opened_at_idx" ON "health_events" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX "health_events_severity_idx" ON "health_events" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "nodes_alias_idx" ON "nodes" USING btree ("alias");--> statement-breakpoint
CREATE INDEX "nodes_status_idx" ON "nodes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "recordings_recorded_at_idx" ON "recordings" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "recordings_schedule_idx" ON "recordings" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "recordings_status_idx" ON "recordings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "schedules_enabled_idx" ON "schedules" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "schedules_node_idx" ON "schedules" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");