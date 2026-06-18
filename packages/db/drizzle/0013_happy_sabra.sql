ALTER TABLE "health_events" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "health_events" ADD COLUMN "acknowledged_by" varchar(160);--> statement-breakpoint
ALTER TABLE "health_events" ADD COLUMN "resolved_by" varchar(160);--> statement-breakpoint
ALTER TABLE "health_events" ADD COLUMN "status" varchar(32) DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "health_events" ADD COLUMN "suppressed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "health_events" ADD COLUMN "suppressed_by" varchar(160);--> statement-breakpoint
ALTER TABLE "health_events" ADD COLUMN "suppressed_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "health_events_status_idx" ON "health_events" USING btree ("status");