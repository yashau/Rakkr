CREATE TYPE "public"."recording_job_status" AS ENUM('queued', 'running', 'stop_requested', 'cancelled', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "recording_jobs" (
	"claimed_by" varchar(160),
	"command" jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"failure_reason" text,
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"node_id" varchar(160) NOT NULL,
	"recording_id" varchar(160) NOT NULL,
	"started_at" timestamp with time zone,
	"status" "recording_job_status" NOT NULL,
	"stop_requested_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "recording_jobs_lease_idx" ON "recording_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "recording_jobs_node_status_idx" ON "recording_jobs" USING btree ("node_id","status");--> statement-breakpoint
CREATE INDEX "recording_jobs_recording_idx" ON "recording_jobs" USING btree ("recording_id");