CREATE TYPE "public"."recording_chunk_status" AS ENUM('capturing', 'cached', 'uploading', 'uploaded', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "recording_chunks" (
	"cached_at" timestamp with time zone,
	"cache_path" text,
	"checksum" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"enhanced_cache_path" text,
	"id" varchar(160) PRIMARY KEY NOT NULL,
	"index" integer NOT NULL,
	"job_id" varchar(160) NOT NULL,
	"offset_seconds" integer DEFAULT 0 NOT NULL,
	"raw_cache_path" text,
	"recording_id" varchar(160) NOT NULL,
	"size_bytes" integer,
	"status" "recording_chunk_status" NOT NULL,
	"total" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upload_queue_items" ADD COLUMN "chunk_id" varchar(160);--> statement-breakpoint
ALTER TABLE "upload_queue_items" ADD COLUMN "chunk_index" integer;--> statement-breakpoint
CREATE INDEX "recording_chunks_job_idx" ON "recording_chunks" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "recording_chunks_recording_idx" ON "recording_chunks" USING btree ("recording_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_chunks_recording_index_unique" ON "recording_chunks" USING btree ("recording_id","index");--> statement-breakpoint
CREATE INDEX "upload_queue_items_chunk_idx" ON "upload_queue_items" USING btree ("chunk_id");--> statement-breakpoint
-- Backfill: chunkSeconds supersedes the deprecated maxTrackSeconds. Copy any
-- existing maxTrackSeconds into chunkSeconds so migrated profiles keep splitting.
UPDATE "recording_profiles" SET "settings" = jsonb_set("settings", '{chunkSeconds}', "settings"->'maxTrackSeconds') WHERE "settings" ? 'maxTrackSeconds' AND NOT ("settings" ? 'chunkSeconds');