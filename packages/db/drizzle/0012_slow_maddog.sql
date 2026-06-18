ALTER TABLE "audio_interfaces" DROP CONSTRAINT "audio_interfaces_node_id_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "health_events" DROP CONSTRAINT "health_events_node_id_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "node_credentials" DROP CONSTRAINT "node_credentials_node_id_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "nodes" ALTER COLUMN "id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "nodes" ALTER COLUMN "id" SET DATA TYPE varchar(160) USING "id"::text;
--> statement-breakpoint
ALTER TABLE "audio_interfaces" ALTER COLUMN "node_id" SET DATA TYPE varchar(160) USING "node_id"::text;
--> statement-breakpoint
ALTER TABLE "health_events" ALTER COLUMN "node_id" SET DATA TYPE varchar(160) USING "node_id"::text;
--> statement-breakpoint
ALTER TABLE "node_credentials" ALTER COLUMN "node_id" SET DATA TYPE varchar(160) USING "node_id"::text;
--> statement-breakpoint
ALTER TABLE "audio_interfaces" ADD CONSTRAINT "audio_interfaces_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "health_events" ADD CONSTRAINT "health_events_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "node_credentials" ADD CONSTRAINT "node_credentials_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
