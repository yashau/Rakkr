CREATE TABLE "user_resource_grants" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by_user_id" uuid,
	"resource_id" varchar(160) NOT NULL,
	"resource_type" varchar(80) NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "user_resource_grants_user_id_resource_type_resource_id_pk" PRIMARY KEY("user_id","resource_type","resource_id")
);
--> statement-breakpoint
ALTER TABLE "user_resource_grants" ADD CONSTRAINT "user_resource_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_resource_grants" ADD CONSTRAINT "user_resource_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_resource_grants_resource_idx" ON "user_resource_grants" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "user_resource_grants_user_idx" ON "user_resource_grants" USING btree ("user_id");