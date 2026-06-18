ALTER TABLE "health_events" DROP CONSTRAINT "health_events_schedule_id_schedules_id_fk";
--> statement-breakpoint
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_node_id_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_recording_profile_id_recording_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_watchdog_policy_id_watchdog_policies_id_fk";
--> statement-breakpoint
ALTER TABLE "health_events" ALTER COLUMN "schedule_id" SET DATA TYPE varchar(160);--> statement-breakpoint
ALTER TABLE "recording_profiles" ALTER COLUMN "id" SET DATA TYPE varchar(160);--> statement-breakpoint
ALTER TABLE "recording_profiles" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "id" SET DATA TYPE varchar(160);--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "node_id" SET DATA TYPE varchar(160);--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "recording_profile_id" SET DATA TYPE varchar(160);--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "watchdog_policy_id" SET DATA TYPE varchar(160);--> statement-breakpoint
ALTER TABLE "watchdog_policies" ALTER COLUMN "id" SET DATA TYPE varchar(160);--> statement-breakpoint
ALTER TABLE "watchdog_policies" ALTER COLUMN "id" DROP DEFAULT;