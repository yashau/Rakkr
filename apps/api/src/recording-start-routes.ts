import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  defaultKeepControllerCacheRetentionPolicy,
  defaultVoiceRecordingProfile,
  type Permission,
  type RecorderNode,
  type RecordingSummary,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import { withCaptureStartLock } from "./capture-start-lock.js";
import { buildCaptureClaims, evaluateAdHocCapture } from "./channel-conflicts.js";
import { resolveChannelMode, validateChannelSelection } from "./channel-selection.js";
import { effectiveCaptureInterfaceId, resolveSelectionRoom } from "./room-resolution.js";
import type { RoomStore } from "./room-store.js";
import { adHocCaptureSeconds, recordingStartRequestSchema } from "./recording-route-helpers.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import { recordingJobTargetOptions } from "./recording-job-targets.js";
import { createRecordingJob, listRecordingJobs } from "./recording-jobs.js";
import {
  defaultAdHocFolder,
  defaultAdHocName,
  recordingStartTarget,
  requestedInterfaceBelongsToNode,
} from "./recording-start-targets.js";
import { uniqueTags } from "./recording-metadata.js";
import type { RecordingStore } from "./recording-store.js";
import { findRetentionPolicy } from "./retention-policies.js";
import type { SettingsStore } from "./settings-store.js";
import {
  profileSettingsTarget,
  retentionPolicySettingsTarget,
  uploadPolicySettingsTarget,
} from "./settings-scope.js";
import { findUploadPolicy, uploadPolicyForQueue } from "./upload-policies.js";

interface RecordingStartRouteDependencies {
  app: Hono<AppBindings>;
  authorizeTarget(
    user: NonNullable<AuthResult["user"]>,
    permission: Permission,
    target: AuditTarget,
  ): Promise<boolean>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  hasResourceScope(user: NonNullable<AuthResult["user"]>, target: AuditTarget): Promise<boolean>;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  requirePermission: RequirePermission;
  roomStore?: RoomStore;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
  settingsStore: SettingsStore;
}

export function registerRecordingStartRoute({
  app,
  authorizeTarget,
  currentAuth,
  currentUser,
  hasResourceScope,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  roomStore,
  scopedNodes,
  settingsStore,
}: RecordingStartRouteDependencies) {
  app.post(
    "/api/v1/recordings",
    requirePermission("recording:create", "recordings.start", recordingStartTarget),
    async (c) => {
      const body = recordingStartRequestSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordRecordingStartFailure(c, "invalid_request");
        return c.json({ error: "Invalid recording start request", issues: body.error.issues }, 400);
      }

      const now = new Date();
      const node = (await scopedNodes(currentUser(c))).find(
        (candidate) => candidate.id === body.data.nodeId,
      );

      if (!node) {
        await recordRecordingStartFailure(c, "node_not_found", body.data.nodeId);
        return c.json({ error: "Node not found" }, 404);
      }

      if (!requestedInterfaceBelongsToNode(node, body.data.captureInterfaceId)) {
        await recordRecordingStartFailure(c, "recording_interface_not_found", node.id, node.alias);
        return c.json({ error: "Recording interface not found" }, 409);
      }

      const resolvedCaptureInterfaceId = effectiveCaptureInterfaceId(
        node,
        body.data.captureInterfaceId,
      );
      const captureInterface = node.interfaces.find(
        (candidate) => candidate.id === resolvedCaptureInterfaceId,
      );
      const channelSelection =
        body.data.captureChannelSelection && body.data.captureChannelSelection.length > 0
          ? body.data.captureChannelSelection
          : undefined;
      let channelMode = body.data.channelMode;

      if (channelSelection) {
        if (!captureInterface) {
          await recordRecordingStartFailure(
            c,
            "recording_interface_not_found",
            node.id,
            node.alias,
          );
          return c.json({ error: "Recording interface not found" }, 409);
        }

        channelMode = resolveChannelMode(channelMode, channelSelection.length);
        const validation = validateChannelSelection(
          captureInterface,
          channelSelection,
          channelMode,
        );

        if (!validation.ok) {
          await recordRecordingStartFailure(c, validation.reason, node.id, node.alias);
          return c.json({ error: "Invalid channel selection", reason: validation.reason }, 400);
        }
      }

      // A recording belongs to exactly one room: resolve it from the selected
      // channels (or the whole interface). Reject a selection spanning rooms, and
      // authorize the caller against that specific room — not the whole node — so a
      // room-A operator cannot capture room B's channels on a shared node.
      const captureRoom = resolvedCaptureInterfaceId
        ? resolveSelectionRoom(node, resolvedCaptureInterfaceId, channelSelection ?? "all")
        : { ok: true as const, roomId: node.roomId };

      if (!captureRoom.ok) {
        await recordRecordingStartFailure(c, "channel_selection_cross_room", node.id, node.alias);
        return c.json(
          {
            error: "Channel selection spans multiple rooms",
            reason: "channel_selection_cross_room",
          },
          400,
        );
      }

      const captureRoomId = captureRoom.roomId;

      if (captureRoomId) {
        if (
          !(await authorizeTarget(currentUser(c), "recording:create", {
            id: captureRoomId,
            type: "room",
          }))
        ) {
          await recordRecordingStartFailure(c, "missing_resource_scope", node.id, node.alias, {
            id: captureRoomId,
            type: "room",
          });
          return c.json({ error: "Forbidden", permission: "recording:create" }, 403);
        }
      } else if (!(await hasResourceScope(currentUser(c), { id: node.id, type: "node" }))) {
        // No room owns this capture (a room-less node with unassigned channels).
        // With no room to check, a roster-only operator must NOT slip through — the
        // node target's room union already let them past the outer gate. Require
        // role/grant authority over the node (roster-blind), mirroring how a
        // room-less schedule falls back to a role-only target.
        await recordRecordingStartFailure(c, "missing_resource_scope", node.id, node.alias);
        return c.json({ error: "Forbidden", permission: "recording:create" }, 403);
      }

      const captureRoomName = captureRoomId
        ? (await roomStore?.find(captureRoomId))?.name
        : undefined;

      const recordingProfileId = body.data.recordingProfileId ?? defaultVoiceRecordingProfile.id;
      const profile = await settingsStore.findRecordingProfile(recordingProfileId);

      if (!profile) {
        await recordRecordingStartFailure(c, "recording_profile_not_found", node.id, node.alias);
        return c.json({ error: "Recording profile not found" }, 404);
      }

      if (
        body.data.recordingProfileId &&
        !(await hasResourceScope(currentUser(c), profileSettingsTarget(profile)))
      ) {
        await recordRecordingStartFailure(
          c,
          "missing_resource_scope",
          node.id,
          node.alias,
          profileSettingsTarget(profile),
        );
        return c.json({ error: "Forbidden", permission: "recording:create" }, 403);
      }

      const requestedUploadPolicyIds = body.data.uploadPolicyIds ?? [];
      const uploadPolicyIds: string[] = [];

      if (requestedUploadPolicyIds.length === 0) {
        uploadPolicyIds.push((await uploadPolicyForQueue(undefined)).id);
      } else {
        for (const requestedPolicyId of requestedUploadPolicyIds) {
          const uploadPolicy = await findUploadPolicy(requestedPolicyId);

          if (!uploadPolicy) {
            await recordRecordingStartFailure(c, "upload_policy_not_found", node.id, node.alias);
            return c.json({ error: "Upload policy not found" }, 404);
          }

          if (!(await hasResourceScope(currentUser(c), uploadPolicySettingsTarget(uploadPolicy)))) {
            await recordRecordingStartFailure(
              c,
              "missing_resource_scope",
              node.id,
              node.alias,
              uploadPolicySettingsTarget(uploadPolicy),
            );
            return c.json({ error: "Forbidden", permission: "recording:create" }, 403);
          }

          uploadPolicyIds.push(uploadPolicy.id);
        }
      }

      const retentionPolicyId =
        body.data.retentionPolicyId ?? defaultKeepControllerCacheRetentionPolicy.id;
      const retentionPolicy = body.data.retentionPolicyId
        ? await findRetentionPolicy(body.data.retentionPolicyId)
        : defaultKeepControllerCacheRetentionPolicy;

      if (!retentionPolicy) {
        await recordRecordingStartFailure(c, "retention_policy_not_found", node.id, node.alias);
        return c.json({ error: "Retention policy not found" }, 404);
      }

      if (
        body.data.retentionPolicyId &&
        !(await hasResourceScope(currentUser(c), retentionPolicySettingsTarget(retentionPolicy)))
      ) {
        await recordRecordingStartFailure(
          c,
          "missing_resource_scope",
          node.id,
          node.alias,
          retentionPolicySettingsTarget(retentionPolicy),
        );
        return c.json({ error: "Forbidden", permission: "recording:create" }, 403);
      }

      // Serialize the conflict/capacity check -> create per node so two
      // concurrent starts can't both pass against a pre-create snapshot and
      // double-create (channel-conflict / maxConcurrentRecordings TOCTOU).
      const startOutcome = await withCaptureStartLock(node.id, async () => {
        const activeJobs = await listRecordingJobs();
        const recordingsById = new Map(
          (await recordingStore.list()).map((entry) => [entry.id, entry]),
        );
        const captureClaims = buildCaptureClaims(activeJobs, recordingsById);
        const captureWindowStartMs = now.getTime();
        const captureDecision = evaluateAdHocCapture(
          captureClaims,
          {
            captureInterfaceId: resolvedCaptureInterfaceId,
            channels: (channelSelection ?? "all") as number[] | "all",
            endMs: captureWindowStartMs + adHocCaptureSeconds() * 1_000,
            nodeId: node.id,
            startMs: captureWindowStartMs,
          },
          node.recordingCapacity?.maxConcurrentRecordings ?? 1,
        );

        if (!captureDecision.ok) {
          return { decision: captureDecision, ok: false as const };
        }

        const recording: RecordingSummary = {
          cached: false,
          durationSeconds: 0,
          folder: body.data.folder ?? defaultAdHocFolder(now, node, captureRoomName),
          healthStatus: "unknown",
          id: `rec_${randomUUID()}`,
          name: body.data.name ?? defaultAdHocName(now, node),
          nodeId: node.id,
          recordedAt: now.toISOString(),
          recordingProfileId,
          retentionPolicyId,
          roomId: captureRoomId,
          source: "ad_hoc",
          status: "recording",
          tags: uniqueTags(body.data.tags ?? ["ad-hoc", "voice"]),
          uploadPolicyIds,
        };

        await recordingStore.create(recording);
        const job = await createRecordingJob(
          recording,
          await recordingJobTargetOptions({
            captureBackend: body.data.captureBackend,
            captureChannelSelection: channelSelection,
            captureGroupId: captureDecision.captureGroupId,
            captureInterfaceId: body.data.captureInterfaceId,
            channelMode,
            node,
            recordingProfileId: recording.recordingProfileId,
            settingsStore,
          }),
        );

        return {
          captureGroupId: captureDecision.captureGroupId,
          job,
          ok: true as const,
          recording,
        };
      });

      if (!startOutcome.ok) {
        await recordRecordingStartFailure(
          c,
          startOutcome.decision.reason,
          node.id,
          node.alias,
          startOutcome.decision.target,
        );
        return c.json(startOutcome.decision.body, 409);
      }

      const { captureGroupId, job, recording } = startOutcome;

      await recordAuditEvent(c, {
        action: "recordings.start.succeeded",
        auth: currentAuth(c),
        correlationIds: {
          jobId: job.id,
          recordingId: recording.id,
        },
        details: {
          captureBackend: body.data.captureBackend,
          captureChannelSelection: channelSelection,
          captureGroupId,
          captureInterfaceId: body.data.captureInterfaceId,
          channelMode,
          jobCommand: job.command,
          jobStatus: job.status,
          profileId: recordingProfileId,
          source: recording.source,
        },
        outcome: "succeeded",
        permission: "recording:create",
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return c.json({ data: recording, job }, 202);
    },
  );

  async function recordRecordingStartFailure(
    c: Context<AppBindings>,
    reason: string,
    nodeId?: string,
    nodeName?: string,
    target?: AuditTarget,
  ) {
    await recordAuditEvent(c, {
      action: "recordings.start.failed",
      auth: currentAuth(c),
      outcome: reason === "missing_resource_scope" ? "denied" : "failed",
      permission: "recording:create",
      reason,
      target: target ?? {
        id: nodeId,
        name: nodeName,
        type: "node",
      },
    });
  }
}
