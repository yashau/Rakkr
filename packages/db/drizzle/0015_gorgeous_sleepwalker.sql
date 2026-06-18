CREATE TABLE "channel_map_templates" (
	"channel_mode" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"id" varchar(160) PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_assignments" (
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by_user_id" uuid,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_id" varchar(160) NOT NULL,
	"target_type" varchar(40) NOT NULL,
	"template_id" varchar(160) NOT NULL,
	"template_kind" varchar(80) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "template_assignments_target_idx" ON "template_assignments" USING btree ("template_kind","target_type","target_id");--> statement-breakpoint
CREATE INDEX "template_assignments_template_idx" ON "template_assignments" USING btree ("template_kind","template_id");