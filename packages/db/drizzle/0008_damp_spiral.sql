CREATE TABLE "node_credentials" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_used_at" timestamp with time zone,
	"node_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"token_hash" text NOT NULL,
	"token_prefix" varchar(48) NOT NULL,
	CONSTRAINT "node_credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "node_credentials" ADD CONSTRAINT "node_credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_credentials" ADD CONSTRAINT "node_credentials_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_credentials_node_idx" ON "node_credentials" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "node_credentials_token_prefix_idx" ON "node_credentials" USING btree ("token_prefix");