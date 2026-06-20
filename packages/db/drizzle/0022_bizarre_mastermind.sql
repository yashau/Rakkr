CREATE TABLE "upload_providers" (
	"credential_ref" text,
	"display_name" varchar(160) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider" varchar(32) PRIMARY KEY NOT NULL,
	"target" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
