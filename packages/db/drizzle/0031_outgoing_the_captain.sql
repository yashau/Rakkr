CREATE TABLE "node_ssh_credentials" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"fingerprint" varchar(160) NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" varchar(160) NOT NULL,
	"private_key_encrypted" text NOT NULL,
	"public_key" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"username" varchar(64) DEFAULT 'rakkr' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_ssh_credentials" ADD CONSTRAINT "node_ssh_credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_ssh_credentials" ADD CONSTRAINT "node_ssh_credentials_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_ssh_credentials_node_idx" ON "node_ssh_credentials" USING btree ("node_id");