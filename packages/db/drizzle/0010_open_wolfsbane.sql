ALTER TABLE "schedules" ADD COLUMN "next_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "room" varchar(160) DEFAULT 'Unknown Room' NOT NULL;