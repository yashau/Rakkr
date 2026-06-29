CREATE TABLE "controller_settings" (
	"controller_name" varchar(160) DEFAULT 'Rakkr Controller' NOT NULL,
	"id" varchar(64) PRIMARY KEY DEFAULT 'controller' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
