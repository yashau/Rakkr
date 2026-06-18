CREATE TYPE "public"."access_policy_effect" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TYPE "public"."access_policy_subject_type" AS ENUM('user', 'group', 'everyone');--> statement-breakpoint
CREATE TABLE "access_groups" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text,
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_policies" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"effect" "access_policy_effect" NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reason" text,
	"resource_id" varchar(160) NOT NULL,
	"resource_type" varchar(80) NOT NULL,
	"subject_id" varchar(160),
	"subject_type" "access_policy_subject_type" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_access_groups" (
	"group_id" varchar(120) NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "user_access_groups_user_id_group_id_pk" PRIMARY KEY("user_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_access_groups" ADD CONSTRAINT "user_access_groups_group_id_access_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."access_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_access_groups" ADD CONSTRAINT "user_access_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_policies_resource_idx" ON "access_policies" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "access_policies_subject_idx" ON "access_policies" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "user_access_groups_group_idx" ON "user_access_groups" USING btree ("group_id");