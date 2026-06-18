ALTER TABLE "health_events" DROP CONSTRAINT "health_events_recording_id_recordings_id_fk";
--> statement-breakpoint
ALTER TABLE "recordings" DROP CONSTRAINT "recordings_node_id_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "recordings" DROP CONSTRAINT "recordings_schedule_id_schedules_id_fk";
--> statement-breakpoint
ALTER TABLE "health_events" ALTER COLUMN "recording_id" SET DATA TYPE varchar(160) USING "recording_id"::text;--> statement-breakpoint
ALTER TABLE "recordings" ALTER COLUMN "id" SET DATA TYPE varchar(160) USING "id"::text;--> statement-breakpoint
ALTER TABLE "recordings" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "recordings" ALTER COLUMN "node_id" SET DATA TYPE varchar(160) USING "node_id"::text;--> statement-breakpoint
ALTER TABLE "recordings" ALTER COLUMN "schedule_id" SET DATA TYPE varchar(160) USING "schedule_id"::text;
