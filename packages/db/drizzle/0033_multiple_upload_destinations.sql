ALTER TYPE "public"."recording_status" ADD VALUE 'partial';--> statement-breakpoint
CREATE TABLE "upload_destinations" (
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"id" varchar(160) PRIMARY KEY NOT NULL,
	"kind" varchar(32) NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upload_policies" ALTER COLUMN "provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "upload_policy_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_policies" ADD COLUMN "destination_id" varchar(160);--> statement-breakpoint
ALTER TABLE "upload_policies" ADD COLUMN "path_override" text;--> statement-breakpoint
ALTER TABLE "upload_queue_items" ADD COLUMN "destination_id" varchar(160);--> statement-breakpoint
ALTER TABLE "upload_queue_items" ADD COLUMN "path_override" text;--> statement-breakpoint
CREATE INDEX "upload_queue_items_destination_status_idx" ON "upload_queue_items" USING btree ("destination_id","status");--> statement-breakpoint
-- Backfill: migrate the single smb/s3 provider rows into named destinations.
INSERT INTO "upload_destinations" ("id", "kind", "display_name", "enabled", "config", "secrets", "updated_at")
SELECT 'upload_dest_' || "provider", "provider", "display_name", "enabled", "config", "secrets", "updated_at"
FROM "upload_providers"
WHERE "provider" IN ('smb', 's3');--> statement-breakpoint
-- Backfill: point existing policies and queue items at the migrated destination of their kind.
UPDATE "upload_policies" SET "destination_id" = 'upload_dest_' || "provider" WHERE "provider" IN ('smb', 's3');--> statement-breakpoint
UPDATE "upload_queue_items" SET "destination_id" = 'upload_dest_' || "provider" WHERE "provider" IN ('smb', 's3');--> statement-breakpoint
-- Backfill: wrap each schedule's single upload policy id into an array.
UPDATE "schedules" SET "upload_policy_ids" = CASE WHEN "upload_policy_id" IS NOT NULL THEN jsonb_build_array("upload_policy_id") ELSE '[]'::jsonb END;--> statement-breakpoint
-- Backfill: rewrite recording metadata uploadPolicyId -> uploadPolicyIds array.
UPDATE "recordings" SET "metadata" = jsonb_set("metadata" - 'uploadPolicyId', '{uploadPolicyIds}', CASE WHEN "metadata" ? 'uploadPolicyId' THEN jsonb_build_array("metadata"->'uploadPolicyId') ELSE '[]'::jsonb END) WHERE "metadata" ? 'uploadPolicyId';