import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// The API pod mounts a ReadWriteOnce PVC for its JSON stores + recording cache
// (`api-pvc.yaml`, `values.yaml` `api.persistence.accessModes: [ReadWriteOnce]`,
// `replicaCount: 1`). A Deployment left on the default RollingUpdate strategy
// tries to start the new pod before terminating the old one on every image-tag
// upgrade; both would mount the same RWO volume, so the new pod is stuck
// Multi-Attach and — with maxUnavailable rounding to 0 at replicas:1 — the
// rollout deadlocks. Recreate is the correct single-writer posture: tear the old
// pod down first, accept a brief cutover, never double-mount. Invisible to the
// Compose smoke (Compose has no rolling-update semantics) and to a fresh
// `helm install` (only an *upgrade* deadlocks).

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("api Deployment uses the Recreate strategy for its single-writer RWO volume", async () => {
  const manifest = await readFile(
    path.join(repoRoot, "deploy/helm/rakkr-controller/templates/api-deployment.yaml"),
    "utf8",
  );

  const strategy = /strategy:\s*\n\s*type:\s*(\S+)/u.exec(manifest);
  assert.ok(
    strategy,
    "api Deployment must declare a strategy — the default RollingUpdate deadlocks on the RWO api-data PVC",
  );
  assert.equal(
    strategy[1],
    "Recreate",
    "api Deployment must use Recreate: RollingUpdate double-mounts the ReadWriteOnce api-data PVC and hangs the upgrade",
  );
});
