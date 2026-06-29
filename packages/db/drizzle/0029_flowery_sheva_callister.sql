ALTER TABLE "upload_providers" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_providers" ADD COLUMN "secrets" jsonb DEFAULT '{}'::jsonb NOT NULL;