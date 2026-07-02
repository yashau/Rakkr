CREATE TABLE "switcher_input_map" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"input" integer NOT NULL,
	"room_id" varchar(160) NOT NULL,
	"switcher_id" varchar(160) NOT NULL,
	CONSTRAINT "switcher_input_map_switcher_id_input_pk" PRIMARY KEY("switcher_id","input")
);
--> statement-breakpoint
CREATE TABLE "switcher_output_map" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"output" integer NOT NULL,
	"switcher_id" varchar(160) NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "switcher_output_map_switcher_id_output_pk" PRIMARY KEY("switcher_id","output")
);
--> statement-breakpoint
CREATE TABLE "switchers" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"host" varchar(255) NOT NULL,
	"id" varchar(160) PRIMARY KEY NOT NULL,
	"inputs" integer NOT NULL,
	"mode" varchar(16) DEFAULT 'observe' NOT NULL,
	"model" varchar(48) NOT NULL,
	"outputs" integer NOT NULL,
	"port" integer NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"username" varchar(120)
);
--> statement-breakpoint
ALTER TABLE "switcher_input_map" ADD CONSTRAINT "switcher_input_map_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switcher_input_map" ADD CONSTRAINT "switcher_input_map_switcher_id_switchers_id_fk" FOREIGN KEY ("switcher_id") REFERENCES "public"."switchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switcher_output_map" ADD CONSTRAINT "switcher_output_map_switcher_id_switchers_id_fk" FOREIGN KEY ("switcher_id") REFERENCES "public"."switchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switcher_output_map" ADD CONSTRAINT "switcher_output_map_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "switcher_input_map_room_idx" ON "switcher_input_map" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "switcher_input_map_room_unique" ON "switcher_input_map" USING btree ("switcher_id","room_id");--> statement-breakpoint
CREATE INDEX "switcher_output_map_user_idx" ON "switcher_output_map" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "switcher_output_map_user_unique" ON "switcher_output_map" USING btree ("switcher_id","user_id");