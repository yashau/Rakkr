CREATE TYPE "public"."audit_outcome" AS ENUM('allowed', 'denied', 'failed', 'partial', 'succeeded');--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "actor_context" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "actor_display_name" varchar(160);--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "actor_roles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "actor_type" varchar(40) DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "after" jsonb;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "before" jsonb;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "correlation_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "outcome" "audit_outcome" DEFAULT 'succeeded' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "outcome" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "permission_id" varchar(120);--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "target_name" varchar(160);--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_outcome_idx" ON "audit_events" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "audit_events_permission_idx" ON "audit_events" USING btree ("permission_id");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");
