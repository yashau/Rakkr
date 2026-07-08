// Drizzle schema surface. Tables live in per-subsystem modules under ./schema;
// this file re-exports them so drizzle-kit (configured with schema:
// ./src/schema.ts) and every consumer see the full table set from one entry.
export * from "./schema/enums.js";
export * from "./schema/auth.js";
export * from "./schema/access.js";
export * from "./schema/rooms.js";
export * from "./schema/nodes.js";
export * from "./schema/node-credentials.js";
export * from "./schema/audio.js";
export * from "./schema/switchers.js";
export * from "./schema/channel-maps.js";
export * from "./schema/settings.js";
export * from "./schema/schedules.js";
export * from "./schema/recordings.js";
export * from "./schema/uploads.js";
export * from "./schema/room-roster.js";
export * from "./schema/health.js";
export * from "./schema/audit.js";
