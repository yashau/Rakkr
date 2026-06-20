CREATE TABLE "upload_policies" (
	"delete_cache_after_upload" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"id" varchar(160) PRIMARY KEY NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"name" varchar(160) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"target" text,
	"trigger" varchar(40) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_queue_items" (
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"cache_path" text,
	"checksum" varchar(160),
	"created_at" timestamp with time zone NOT NULL,
	"file_name" text NOT NULL,
	"id" varchar(160) PRIMARY KEY NOT NULL,
	"last_error" text,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"provider" varchar(32) NOT NULL,
	"recording_id" varchar(160) NOT NULL,
	"status" varchar(32) NOT NULL,
	"target" text,
	"updated_at" timestamp with time zone NOT NULL,
	"upload_policy_id" varchar(160)
);
--> statement-breakpoint
CREATE INDEX "upload_queue_items_due_idx" ON "upload_queue_items" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "upload_queue_items_provider_status_idx" ON "upload_queue_items" USING btree ("provider","status");--> statement-breakpoint
CREATE INDEX "upload_queue_items_recording_idx" ON "upload_queue_items" USING btree ("recording_id");