CREATE TABLE "oidc_login_states" (
	"code_verifier" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"nonce" text NOT NULL,
	"return_to" text,
	"state_hash" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE INDEX "oidc_login_states_expires_at_idx" ON "oidc_login_states" USING btree ("expires_at");