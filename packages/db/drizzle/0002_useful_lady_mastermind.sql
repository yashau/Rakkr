ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_permission_id_permissions_id_fk";
--> statement-breakpoint
DROP INDEX "audit_events_actor_idx";--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "actor_id" varchar(160);--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id");