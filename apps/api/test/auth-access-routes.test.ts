import assert from "node:assert/strict";
import test from "node:test";
import type {
  AccessPolicy,
  AccessPolicyInput,
  AuditEvent,
  HealthEvent,
  RecordingSummary,
  ScheduleSummary,
} from "@rakkr/shared";

process.env.DATABASE_URL = "";
process.env.RAKKR_API_NO_LISTEN = "1";
process.env.RAKKR_LOCAL_ACCESS_POLICIES = "";

const { app } = await import("../src/index.js");

test("access policy updates audit before and after snapshots", async () => {
  const token = await loginToken();
  const policies = [
    {
      effect: "deny",
      reason: "room_maintenance",
      resourceId: "node_room_alpha",
      resourceType: "node",
      subjectType: "everyone",
    },
  ];

  const response = await updateAccessPolicies(token, policies);
  const body = (await response.json()) as { data: AccessPolicy[] };
  const eventsResponse = await app.request(
    "/api/v1/audit-events?action=auth.access_policies.update.succeeded",
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  const eventsBody = (await eventsResponse.json()) as { data: AuditEvent[] };
  const [event] = eventsBody.data;

  assert.equal(response.status, 200);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0]?.effect, "deny");
  assert.equal(eventsResponse.status, 200);
  assert.equal(event?.permission, "auth:manage");
  assert.equal(event?.target.type, "auth");
  assert.deepEqual(event?.before, { policies: [] });
  assert.equal(
    (event?.after?.policies as AccessPolicy[] | undefined)?.[0]?.reason,
    "room_maintenance",
  );
});

test("recording resource denies block metadata edits and bulk organization", async () => {
  const token = await loginToken();
  const recordingId = "rec_demo_001";

  await updateAccessPolicies(token, [
    {
      effect: "deny",
      reason: "sealed_room",
      resourceId: recordingId,
      resourceType: "recording",
      subjectType: "everyone",
    },
  ]);

  try {
    const response = await app.request(`/api/v1/recordings/${recordingId}/metadata`, {
      body: JSON.stringify({ name: "Blocked Rename" }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "PATCH",
    });
    const bulkResponse = await app.request("/api/v1/recordings/bulk-metadata", {
      body: JSON.stringify({
        folder: "Blocked",
        recordingIds: [recordingId],
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "PATCH",
    });
    const eventsResponse = await app.request(
      [
        "/api/v1/audit-events",
        "?action=recordings.metadata.update",
        "&outcome=denied",
        "&permission=recording%3Aedit",
        `&target=${recordingId}`,
      ].join(""),
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    const eventsBody = (await eventsResponse.json()) as { data: AuditEvent[] };
    const [event] = eventsBody.data;
    const bulkEvent = await deniedAuditEvent(
      token,
      "recordings.metadata.bulk_update.failed",
      "recording:edit",
      "recording_collection",
    );

    assert.equal(response.status, 403);
    assert.equal(bulkResponse.status, 404);
    assert.equal(eventsResponse.status, 200);
    assert.equal(event?.permission, "recording:edit");
    assert.equal(event?.reason, "access_policy_denied");
    assert.equal(event?.target.id, recordingId);
    assert.equal(event?.target.type, "recording");
    assert.equal(event?.details.resourceScopeDecision, "access_policy_denied");
    assert.equal(bulkEvent?.reason, "recording_not_visible");
    assert.deepEqual(bulkEvent?.details.hiddenIds, [recordingId]);
  } finally {
    await updateAccessPolicies(token, []);
  }
});

test("node resource denies block live listen and audit the denial", async () => {
  const token = await loginToken();
  const nodeId = "node_x32_test";

  await updateAccessPolicies(token, [
    {
      effect: "deny",
      reason: "room_restricted",
      resourceId: nodeId,
      resourceType: "node",
      subjectType: "everyone",
    },
  ]);

  try {
    const response = await app.request(`/api/v1/nodes/${nodeId}/listen`, {
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
    });
    const eventsResponse = await app.request(
      [
        "/api/v1/audit-events",
        "?action=listen.monitor.start",
        "&outcome=denied",
        "&permission=listen%3Amonitor",
        `&target=${nodeId}`,
      ].join(""),
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    const eventsBody = (await eventsResponse.json()) as { data: AuditEvent[] };
    const [event] = eventsBody.data;

    assert.equal(response.status, 403);
    assert.equal(eventsResponse.status, 200);
    assert.equal(event?.permission, "listen:monitor");
    assert.equal(event?.reason, "access_policy_denied");
    assert.equal(event?.target.id, nodeId);
    assert.equal(event?.target.type, "node");
    assert.equal(event?.details.resourceScopeDecision, "access_policy_denied");
  } finally {
    await updateAccessPolicies(token, []);
  }
});

test("recording resource denies block stop control and audit the denial", async () => {
  const token = await loginToken();
  const recordingId = "rec_demo_001";

  await updateAccessPolicies(token, [
    {
      effect: "deny",
      reason: "recording_locked",
      resourceId: recordingId,
      resourceType: "recording",
      subjectType: "everyone",
    },
  ]);

  try {
    const response = await app.request(`/api/v1/recordings/${recordingId}/stop`, {
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
    });
    const eventsResponse = await app.request(
      [
        "/api/v1/audit-events",
        "?action=recordings.stop",
        "&outcome=denied",
        "&permission=recording%3Acontrol",
        `&target=${recordingId}`,
      ].join(""),
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    const eventsBody = (await eventsResponse.json()) as { data: AuditEvent[] };
    const [event] = eventsBody.data;

    assert.equal(response.status, 403);
    assert.equal(eventsResponse.status, 200);
    assert.equal(event?.permission, "recording:control");
    assert.equal(event?.reason, "access_policy_denied");
    assert.equal(event?.target.id, recordingId);
    assert.equal(event?.target.type, "recording");
    assert.equal(event?.details.resourceScopeDecision, "access_policy_denied");
  } finally {
    await updateAccessPolicies(token, []);
  }
});

test("recording resource denies block playback download upload queue and delete actions", async () => {
  const token = await loginToken();
  const recordingId = "rec_demo_001";

  await updateAccessPolicies(token, [
    {
      effect: "deny",
      reason: "recording_sealed",
      resourceId: recordingId,
      resourceType: "recording",
      subjectType: "everyone",
    },
  ]);

  try {
    const playbackResponse = await app.request(`/api/v1/recordings/${recordingId}/playback`, {
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
    });
    const downloadResponse = await app.request(`/api/v1/recordings/${recordingId}/download`, {
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
    });
    const uploadResponse = await app.request(`/api/v1/recordings/${recordingId}/upload-queue`, {
      body: JSON.stringify({ reason: "manual_retry" }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const bulkUploadResponse = await app.request("/api/v1/recordings/bulk-upload-queue", {
      body: JSON.stringify({ recordingIds: [recordingId] }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const deleteResponse = await app.request(`/api/v1/recordings/${recordingId}`, {
      headers: { authorization: `Bearer ${token}` },
      method: "DELETE",
    });
    const bulkDeleteResponse = await app.request("/api/v1/recordings/bulk-delete", {
      body: JSON.stringify({ recordingIds: [recordingId] }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const playbackEvent = await deniedAuditEvent(
      token,
      "recordings.playback.start",
      "recording:playback",
      recordingId,
    );
    const downloadEvent = await deniedAuditEvent(
      token,
      "recordings.download.prepare",
      "recording:download",
      recordingId,
    );
    const uploadEvent = await deniedAuditEvent(
      token,
      "recordings.upload_queue.enqueue",
      "recording:control",
      recordingId,
    );
    const bulkUploadEvent = await deniedAuditEvent(
      token,
      "recordings.upload_queue.bulk_enqueue.failed",
      "recording:control",
      "recording_collection",
    );
    const deleteEvent = await deniedAuditEvent(
      token,
      "recordings.delete",
      "recording:delete",
      recordingId,
    );
    const bulkDeleteEvent = await deniedAuditEvent(
      token,
      "recordings.bulk_delete.failed",
      "recording:delete",
      "recording_collection",
    );

    assert.equal(playbackResponse.status, 403);
    assert.equal(downloadResponse.status, 403);
    assert.equal(uploadResponse.status, 403);
    assert.equal(bulkUploadResponse.status, 404);
    assert.equal(deleteResponse.status, 403);
    assert.equal(bulkDeleteResponse.status, 404);
    assert.equal(playbackEvent?.reason, "access_policy_denied");
    assert.equal(downloadEvent?.reason, "access_policy_denied");
    assert.equal(uploadEvent?.reason, "access_policy_denied");
    assert.equal(bulkUploadEvent?.reason, "recording_not_visible");
    assert.equal(deleteEvent?.reason, "access_policy_denied");
    assert.equal(bulkDeleteEvent?.reason, "recording_not_visible");
    assert.equal(playbackEvent?.target.id, recordingId);
    assert.equal(downloadEvent?.target.id, recordingId);
    assert.equal(uploadEvent?.target.id, recordingId);
    assert.equal(bulkUploadEvent?.target.id, "recording_collection");
    assert.deepEqual(bulkUploadEvent?.details.hiddenIds, [recordingId]);
    assert.equal(deleteEvent?.target.id, recordingId);
    assert.equal(bulkDeleteEvent?.target.id, "recording_collection");
    assert.deepEqual(bulkDeleteEvent?.details.hiddenIds, [recordingId]);
  } finally {
    await updateAccessPolicies(token, []);
  }
});

test("node resource denies hide attached recordings and block recording edits", async () => {
  const token = await loginToken();
  const nodeId = "node_x32_test";
  const recordingId = "rec_demo_001";

  await updateAccessPolicies(token, [
    {
      effect: "deny",
      reason: "recorder_quarantined",
      resourceId: nodeId,
      resourceType: "node",
      subjectType: "everyone",
    },
  ]);

  try {
    const listResponse = await app.request("/api/v1/recordings", {
      headers: { authorization: `Bearer ${token}` },
    });
    const listBody = (await listResponse.json()) as { data: RecordingSummary[] };
    const editResponse = await app.request(`/api/v1/recordings/${recordingId}/metadata`, {
      body: JSON.stringify({ tags: ["blocked"] }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "PATCH",
    });
    const eventsResponse = await app.request(
      [
        "/api/v1/audit-events",
        "?action=recordings.metadata.update",
        "&outcome=denied",
        "&permission=recording%3Aedit",
        `&target=${recordingId}`,
      ].join(""),
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    const eventsBody = (await eventsResponse.json()) as { data: AuditEvent[] };
    const [event] = eventsBody.data;

    assert.equal(listResponse.status, 200);
    assert.equal(
      listBody.data.some((recording) => recording.id === recordingId),
      false,
    );
    assert.equal(editResponse.status, 403);
    assert.equal(event?.permission, "recording:edit");
    assert.equal(event?.reason, "access_policy_denied");
    assert.equal(event?.target.id, recordingId);
  } finally {
    await updateAccessPolicies(token, []);
  }
});

test("schedule resource denies hide schedules and block run-now control", async () => {
  const token = await loginToken();
  const scheduleId = "sched_council_weekly";

  await updateAccessPolicies(token, [
    {
      effect: "deny",
      reason: "schedule_restricted",
      resourceId: scheduleId,
      resourceType: "schedule",
      subjectType: "everyone",
    },
  ]);

  try {
    const listResponse = await app.request("/api/v1/schedules", {
      headers: { authorization: `Bearer ${token}` },
    });
    const listBody = (await listResponse.json()) as { data: ScheduleSummary[] };
    const runResponse = await app.request(`/api/v1/schedules/${scheduleId}/run-now`, {
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
    });
    const eventsResponse = await app.request(
      [
        "/api/v1/audit-events",
        "?action=schedules.run_now",
        "&outcome=denied",
        "&permission=schedule%3Amanage",
        `&target=${scheduleId}`,
      ].join(""),
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    const eventsBody = (await eventsResponse.json()) as { data: AuditEvent[] };
    const [event] = eventsBody.data;

    assert.equal(listResponse.status, 200);
    assert.equal(
      listBody.data.some((schedule) => schedule.id === scheduleId),
      false,
    );
    assert.equal(runResponse.status, 403);
    assert.equal(event?.permission, "schedule:manage");
    assert.equal(event?.reason, "access_policy_denied");
    assert.equal(event?.target.id, scheduleId);
  } finally {
    await updateAccessPolicies(token, []);
  }
});

test("node resource denies hide health events and block alert acknowledgement", async () => {
  const token = await loginToken();
  const nodeId = "node_x32_test";
  const createResponse = await app.request("/api/v1/health-events", {
    body: JSON.stringify({
      details: { source: "rbac-test" },
      nodeId,
      severity: "critical",
      type: "watchdog.test_node_alert",
    }),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const createBody = (await createResponse.json()) as { data: HealthEvent };
  const eventId = createBody.data.id;

  await updateAccessPolicies(token, [
    {
      effect: "deny",
      reason: "alert_room_restricted",
      resourceId: nodeId,
      resourceType: "node",
      subjectType: "everyone",
    },
  ]);

  try {
    const listResponse = await app.request("/api/v1/health-events", {
      headers: { authorization: `Bearer ${token}` },
    });
    const listBody = (await listResponse.json()) as { data: HealthEvent[] };
    const acknowledgeResponse = await app.request(`/api/v1/health-events/${eventId}/acknowledge`, {
      body: JSON.stringify({ note: "blocked" }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const eventsResponse = await app.request(
      [
        "/api/v1/audit-events",
        "?action=health.events.acknowledge.failed",
        "&outcome=denied",
        "&permission=health%3Aacknowledge",
        `&target=${eventId}`,
      ].join(""),
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    const eventsBody = (await eventsResponse.json()) as { data: AuditEvent[] };
    const [event] = eventsBody.data;

    assert.equal(createResponse.status, 201);
    assert.equal(listResponse.status, 200);
    assert.equal(
      listBody.data.some((healthEvent) => healthEvent.id === eventId),
      false,
    );
    assert.equal(acknowledgeResponse.status, 403);
    assert.equal(event?.permission, "health:acknowledge");
    assert.equal(event?.reason, "missing_resource_scope");
    assert.equal(event?.target.id, eventId);
    assert.equal(event?.target.type, "health_event");
  } finally {
    await updateAccessPolicies(token, []);
  }
});

async function loginToken() {
  const response = await app.request("/api/v1/auth/login", {
    body: JSON.stringify({
      email: "admin@rakkr.local",
      password: "rakkr-local-dev-password",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { data: { token: string } };

  assert.equal(response.status, 200);

  return body.data.token;
}

async function updateAccessPolicies(token: string, policies: AccessPolicyInput[]) {
  return app.request("/api/v1/auth/access-policies", {
    body: JSON.stringify({ policies }),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "PATCH",
  });
}

async function deniedAuditEvent(token: string, action: string, permission: string, target: string) {
  const params = new URLSearchParams({
    action,
    outcome: "denied",
    permission,
    target,
  });
  const response = await app.request(`/api/v1/audit-events?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as { data: AuditEvent[] };

  assert.equal(response.status, 200);

  return body.data[0];
}
