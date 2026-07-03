ALTER TABLE "audio_channels" ADD COLUMN "room_id" varchar(160);--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "room_id" varchar(160);--> statement-breakpoint
ALTER TABLE "audio_channels" ADD CONSTRAINT "audio_channels_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audio_channels_room_idx" ON "audio_channels" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "recordings_room_idx" ON "recordings" USING btree ("room_id");--> statement-breakpoint
-- Backfill: room ownership moves from the node down to its channels. Fan each
-- node's current room to all of that node's channels, preserving the existing
-- one-node-one-room behavior as the default partition. Null-safe / no-op on an
-- empty database.
UPDATE "audio_channels" "ac"
SET "room_id" = "n"."room_id"
FROM "audio_interfaces" "ai"
JOIN "nodes" "n" ON "n"."id" = "ai"."node_id"
WHERE "ai"."id" = "ac"."interface_id"
  AND "n"."room_id" IS NOT NULL
  AND "ac"."room_id" IS NULL;--> statement-breakpoint
-- Backfill: attribute each existing recording to its node's room so historical
-- recordings keep their room-scoped visibility after the RBAC cutover.
UPDATE "recordings" "r"
SET "room_id" = "n"."room_id"
FROM "nodes" "n"
WHERE "n"."id" = "r"."node_id"
  AND "n"."room_id" IS NOT NULL
  AND "r"."room_id" IS NULL;