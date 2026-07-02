import { z } from "zod";

import { isoDateTimeSchema } from "./base.js";

// Audio matrix switcher contracts shared between the controller API and the
// operator console. The device driver (raw TCP command protocol) lives
// server-side in apps/api/src/switchers; this file is the shared source of
// truth for switcher identity, connection config, routing mode, and the
// room/user channel mappings that drive auto-routing.
//
// Model concept: a switcher exposes N audio INPUTS (room feeds) and N audio
// OUTPUTS (listener desks). Operators optionally map inputs -> rooms and
// outputs -> users; when a room's scheduled meeting is live and assigned to a
// user, the controller routes that room's input to the user's output.

// Supported switcher models. Adding a model = a new driver in
// apps/api/src/switchers + an entry in switcherModelCatalog below.
export const switcherModelSchema = z.enum(["avpro-ac-max"]);

// Per-model static capabilities. Channel counts and the default control port
// come from here so the API and UI validate mappings against the same bounds.
export interface SwitcherModelInfo {
  defaultPort: number;
  inputs: number;
  label: string;
  model: SwitcherModel;
  outputs: number;
  // Some models require a login handshake on the control channel. The AVPro
  // AC-MAX telnet port is open (its username/password guard the web GUI only),
  // so stored credentials are optional and unused by that driver.
  requiresLogin: boolean;
  supportsInputSignal: boolean;
  supportsSnapshot: boolean;
}

export const switcherModelCatalog: Record<SwitcherModel, SwitcherModelInfo> = {
  "avpro-ac-max": {
    defaultPort: 23,
    inputs: 24,
    label: "AVPro Edge AC-MAX (24×24 audio matrix)",
    model: "avpro-ac-max",
    outputs: 24,
    requiresLogin: false,
    supportsInputSignal: true,
    supportsSnapshot: true,
  },
};

export function switcherModelInfo(model: SwitcherModel): SwitcherModelInfo {
  return switcherModelCatalog[model];
}

// disabled: the controller never connects. observe: compute + audit the routes
// it *would* apply but never send SET commands (dry-run for rollout alongside a
// human operator). enforce: apply routing changes to the device.
export const switcherModeSchema = z.enum(["disabled", "observe", "enforce"]);

const switcherHostSchema = z.string().trim().min(1).max(255);
const switcherPortSchema = z.number().int().min(1).max(65_535);
const switcherChannelSchema = z.number().int().min(1).max(256);

// Core switcher record (persisted, non-secret). inputs/outputs are resolved
// from the model. The control-channel password is stored separately, encrypted.
export const switcherSchema = z.object({
  createdAt: isoDateTimeSchema,
  displayName: z.string().min(1),
  enabled: z.boolean(),
  host: switcherHostSchema,
  id: z.string().min(1),
  inputs: z.number().int().positive(),
  mode: switcherModeSchema,
  model: switcherModelSchema,
  outputs: z.number().int().positive(),
  port: switcherPortSchema,
  updatedAt: isoDateTimeSchema,
  username: z.string().max(120).optional(),
});

// API response shape: the redacted record plus whether a control-channel
// password is stored. The password value itself is never serialized.
export const switcherStatusSchema = switcherSchema.extend({
  hasPassword: z.boolean(),
});

// Create payload. Named *Create (not *Input) to avoid confusion with the
// switcher's audio "inputs". `model` is fixed at creation; `port` defaults to
// the model's control port; `mode` defaults to observe so a new switcher never
// drives hardware until an operator promotes it to enforce.
export const switcherCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  enabled: z.boolean().default(true),
  host: switcherHostSchema,
  id: z.string().trim().min(1).max(160).optional(),
  mode: switcherModeSchema.default("observe"),
  model: switcherModelSchema.default("avpro-ac-max"),
  password: z.string().max(255).optional(),
  port: switcherPortSchema.optional(),
  username: z.string().trim().max(120).optional(),
});

// Update payload. `model` is immutable (driver + channel counts are fixed). A
// password of "" clears the stored secret; username null clears it.
export const switcherUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160).optional(),
    enabled: z.boolean().optional(),
    host: switcherHostSchema.optional(),
    mode: switcherModeSchema.optional(),
    password: z.string().max(255).optional(),
    port: switcherPortSchema.optional(),
    username: z.string().trim().max(120).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one switcher field is required");

// A single input->room binding (room feed on a switcher input jack).
export const switcherInputMappingSchema = z.object({
  input: z.number().int().positive(),
  roomId: z.string().min(1),
  roomName: z.string().min(1).optional(),
});

// A single output->user binding (a listener's desk on a switcher output jack).
export const switcherOutputMappingSchema = z.object({
  output: z.number().int().positive(),
  userEmail: z.string().optional(),
  userId: z.string().min(1),
  userName: z.string().min(1).optional(),
});

export const switcherMappingsSchema = z.object({
  inputs: z.array(switcherInputMappingSchema),
  outputs: z.array(switcherOutputMappingSchema),
});

// Replace-all payload for a switcher's mappings (the grid UI submits the whole
// map). Per-channel range + uniqueness + room/user existence are enforced
// server-side where model bounds and scope are known.
export const switcherMappingsUpdateSchema = z.object({
  inputs: z
    .array(
      z.object({
        input: switcherChannelSchema,
        roomId: z.string().trim().min(1).max(160),
      }),
    )
    .max(256),
  outputs: z
    .array(
      z.object({
        output: switcherChannelSchema,
        userId: z.string().trim().min(1).max(160),
      }),
    )
    .max(256),
});

// Result of a connection test / probe against a live switcher.
export const switcherConnectionTestSchema = z.object({
  firmware: z.string().optional(),
  message: z.string().optional(),
  model: switcherModelSchema,
  ok: z.boolean(),
  reachable: z.boolean(),
  routeCount: z.number().int().nonnegative().optional(),
});

// One output's live routing state as shown in the console's routes panel.
// `managed` = this output is mapped to a user (Rakkr-owned); `desiredInput` =
// what the reconcile loop wants routed right now (the active meeting's input),
// absent when idle. `signal` = the input's SIG STA (0..3) when known.
export const switcherRouteViewSchema = z.object({
  desiredInput: z.number().int().nonnegative().optional(),
  input: z.number().int().nonnegative(),
  managed: z.boolean(),
  output: z.number().int().positive(),
  roomId: z.string().optional(),
  roomName: z.string().optional(),
  signal: z.number().int().min(0).max(3).optional(),
  userId: z.string().optional(),
  userName: z.string().optional(),
});

// Picker directory for the mapping editor.
export const switcherMappingOptionsSchema = z.object({
  rooms: z.array(z.object({ id: z.string(), name: z.string(), site: z.string() })),
  users: z.array(z.object({ email: z.string().optional(), id: z.string(), name: z.string() })),
});

export const switcherRoutingSnapshotSchema = z.object({
  capturedAt: isoDateTimeSchema,
  reachable: z.boolean(),
  routes: z.array(switcherRouteViewSchema),
  switcherId: z.string().min(1),
});

export type SwitcherModel = z.infer<typeof switcherModelSchema>;
export type SwitcherMode = z.infer<typeof switcherModeSchema>;
export type Switcher = z.infer<typeof switcherSchema>;
export type SwitcherStatus = z.infer<typeof switcherStatusSchema>;
export type SwitcherCreate = z.infer<typeof switcherCreateSchema>;
export type SwitcherUpdate = z.infer<typeof switcherUpdateSchema>;
export type SwitcherInputMapping = z.infer<typeof switcherInputMappingSchema>;
export type SwitcherOutputMapping = z.infer<typeof switcherOutputMappingSchema>;
export type SwitcherMappings = z.infer<typeof switcherMappingsSchema>;
export type SwitcherMappingsUpdate = z.infer<typeof switcherMappingsUpdateSchema>;
export type SwitcherConnectionTest = z.infer<typeof switcherConnectionTestSchema>;
export type SwitcherMappingOptions = z.infer<typeof switcherMappingOptionsSchema>;
export type SwitcherRouteView = z.infer<typeof switcherRouteViewSchema>;
export type SwitcherRoutingSnapshot = z.infer<typeof switcherRoutingSnapshotSchema>;
