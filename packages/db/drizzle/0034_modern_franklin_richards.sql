ALTER TABLE "schedules" ADD COLUMN "capture_channel_selection" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "channel_mode" varchar(32);