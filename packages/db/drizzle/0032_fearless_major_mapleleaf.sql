CREATE TABLE "node_bootstrap_tokens" (
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" varchar(160) NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" varchar(48) NOT NULL,
	CONSTRAINT "node_bootstrap_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "node_bootstrap_tokens" ADD CONSTRAINT "node_bootstrap_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_bootstrap_tokens" ADD CONSTRAINT "node_bootstrap_tokens_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_bootstrap_tokens_node_idx" ON "node_bootstrap_tokens" USING btree ("node_id");