ALTER TABLE "controller_settings" ADD COLUMN "default_recording_profile_id" varchar(160);--> statement-breakpoint
ALTER TABLE "controller_settings" ADD COLUMN "default_retention_policy_id" varchar(160);--> statement-breakpoint
ALTER TABLE "controller_settings" ADD COLUMN "default_upload_policy_id" varchar(160);--> statement-breakpoint
ALTER TABLE "controller_settings" ADD COLUMN "default_watchdog_policy_id" varchar(160);