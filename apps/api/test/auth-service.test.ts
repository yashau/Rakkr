import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser } from "@rakkr/shared";
import { LocalAuthService } from "../src/auth-service.js";

test("access policy decisions prefer denies over matching allows", async () => {
  const service = new LocalAuthService("");
  const user = accessUser({
    groups: [{ id: "operators", name: "Operators" }],
    id: "user_operator",
  });

  await service.updateLocalAccessPolicies(
    [
      {
        effect: "allow",
        resourceId: "node_room_alpha",
        resourceType: "node",
        subjectType: "everyone",
      },
      {
        effect: "deny",
        reason: "maintenance_hold",
        resourceId: "node_room_alpha",
        resourceType: "node",
        subjectId: "operators",
        subjectType: "group",
      },
    ],
    "user_owner",
  );

  const decision = await service.accessPolicyDecision(user, [
    { id: "node_room_alpha", type: "node" },
  ]);

  assert.equal(decision?.effect, "deny");
  assert.equal(decision?.policy.reason, "maintenance_hold");
});

test("access policy decisions match user group and wildcard recorder scopes", async () => {
  const service = new LocalAuthService("");
  const user = accessUser({
    email: "room-viewer@example.com",
    groups: [{ id: "room_viewers", name: "Room Viewers" }],
    id: "user_room_viewer",
  });

  await service.updateLocalAccessPolicies(
    [
      {
        effect: "allow",
        resourceId: "room_alpha",
        resourceType: "room",
        subjectId: "room_viewers",
        subjectType: "group",
      },
      {
        effect: "deny",
        resourceId: "node_secret",
        resourceType: "node",
        subjectType: "everyone",
      },
    ],
    "user_owner",
  );

  const roomDecision = await service.accessPolicyDecision(user, [
    { id: "node_room_alpha", type: "node" },
    { id: "room_alpha", type: "room" },
  ]);
  const deniedNodeDecision = await service.accessPolicyDecision(user, [
    { id: "node_secret", type: "node" },
    { id: "room_alpha", type: "room" },
  ]);

  assert.equal(roomDecision?.effect, "allow");
  assert.equal(roomDecision?.policy.resourceType, "room");
  assert.equal(deniedNodeDecision?.effect, "deny");
  assert.equal(deniedNodeDecision?.policy.resourceId, "node_secret");
});

function accessUser(input: {
  email?: string;
  groups?: CurrentUser["groups"];
  id: string;
}): CurrentUser {
  return {
    email: input.email ?? `${input.id}@example.com`,
    groups: input.groups ?? [],
    id: input.id,
    name: input.id,
    permissions: ["recording:read"],
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}
