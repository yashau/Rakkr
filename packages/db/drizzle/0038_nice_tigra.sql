CREATE TYPE "public"."room_roster_source" AS ENUM('manual', 'calendar');--> statement-breakpoint
CREATE TYPE "public"."room_roster_subject_type" AS ENUM('user', 'group');--> statement-breakpoint
CREATE TABLE "room_roster" (
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by_user_id" uuid,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" varchar(160) NOT NULL,
	"source" "room_roster_source" DEFAULT 'manual' NOT NULL,
	"source_schedule_id" varchar(160),
	"subject_id" varchar(160) NOT NULL,
	"subject_type" "room_roster_subject_type" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"building" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text,
	"floor" varchar(160),
	"id" varchar(160) PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL,
	"notes" text,
	"site" varchar(160) DEFAULT 'Unknown Site' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "room_id" varchar(160);--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "room_id" varchar(160);--> statement-breakpoint
ALTER TABLE "room_roster" ADD CONSTRAINT "room_roster_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_roster" ADD CONSTRAINT "room_roster_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_roster" ADD CONSTRAINT "room_roster_source_schedule_id_schedules_id_fk" FOREIGN KEY ("source_schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_roster_room_idx" ON "room_roster" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_roster_schedule_idx" ON "room_roster" USING btree ("source_schedule_id");--> statement-breakpoint
CREATE INDEX "room_roster_subject_idx" ON "room_roster" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "rooms_site_idx" ON "rooms" USING btree ("site");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_site_name_idx" ON "rooms" USING btree ("site","name");--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nodes_room_idx" ON "nodes" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "schedules_room_idx" ON "schedules" USING btree ("room_id");--> statement-breakpoint
-- Backfill: promote existing free-text node/schedule locations to first-class rooms,
-- link nodes + schedules, seed the roster from existing schedule assignments, and
-- re-key any composite-string room grants onto the stable roomId. Room ids are a
-- deterministic hash of lower(site)/lower(name) so the backfill is idempotent.
INSERT INTO "rooms" ("id", "name", "site")
SELECT DISTINCT 'room_' || md5(lower(site) || '/' || lower(name)), name, site
FROM (
  SELECT
    COALESCE(NULLIF(trim("location"->>'site'), ''), 'Unknown Site') AS site,
    COALESCE(NULLIF(trim("location"->>'room'), ''), 'Unknown Room') AS name
  FROM "nodes"
) AS node_rooms
ON CONFLICT ("site", "name") DO NOTHING;--> statement-breakpoint
UPDATE "nodes" AS n
SET "room_id" = 'room_' || md5(
  lower(COALESCE(NULLIF(trim(n."location"->>'site'), ''), 'Unknown Site')) || '/' ||
  lower(COALESCE(NULLIF(trim(n."location"->>'room'), ''), 'Unknown Room'))
);--> statement-breakpoint
UPDATE "schedules" AS s
SET "room_id" = n."room_id"
FROM "nodes" AS n
WHERE n."id" = s."node_id" AND n."room_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "rooms" ("id", "name", "site")
SELECT DISTINCT 'room_' || md5('unknown site' || '/' || lower(name)), name, 'Unknown Site'
FROM (
  SELECT COALESCE(NULLIF(trim("room"), ''), 'Unknown Room') AS name
  FROM "schedules"
  WHERE "room_id" IS NULL
) AS orphan_rooms
ON CONFLICT ("site", "name") DO NOTHING;--> statement-breakpoint
UPDATE "schedules"
SET "room_id" = 'room_' || md5('unknown site' || '/' || lower(COALESCE(NULLIF(trim("room"), ''), 'Unknown Room')))
WHERE "room_id" IS NULL;--> statement-breakpoint
INSERT INTO "room_roster" ("room_id", "subject_type", "subject_id", "capabilities", "source", "source_schedule_id")
SELECT s."room_id", 'user', assignee.value,
  '["view","listen","download","operate","book","edit","delete"]'::jsonb, 'calendar', s."id"
FROM "schedules" s
CROSS JOIN LATERAL jsonb_array_elements_text(s."assigned_user_ids") AS assignee(value)
WHERE s."room_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "room_roster" ("room_id", "subject_type", "subject_id", "capabilities", "source", "source_schedule_id")
SELECT s."room_id", 'group', assignee.value,
  '["view","listen","download","operate","book","edit","delete"]'::jsonb, 'calendar', s."id"
FROM "schedules" s
CROSS JOIN LATERAL jsonb_array_elements_text(s."assigned_group_ids") AS assignee(value)
WHERE s."room_id" IS NOT NULL;--> statement-breakpoint
UPDATE "access_policies" AS p
SET "resource_id" = r."id"
FROM "rooms" AS r
WHERE p."resource_type" = 'room' AND p."resource_id" = r."site" || '/' || r."name";--> statement-breakpoint
UPDATE "user_resource_grants" AS grt
SET "resource_id" = r."id"
FROM "rooms" AS r
WHERE grt."resource_type" = 'room' AND grt."resource_id" = r."site" || '/' || r."name";