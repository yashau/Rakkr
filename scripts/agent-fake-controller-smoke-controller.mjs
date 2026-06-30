import { empty, json, readBody } from "./agent-fake-controller-smoke-utils.mjs";

export function createFakeControllerHandler({
  activeScenario,
  nodeId,
  recorderCachePoliciesForScenario,
  token,
}) {
  return async function handleControllerRequest(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const context = activeScenario();

    if (request.headers.authorization !== `Bearer ${token}`) {
      return json(response, 401, { error: "invalid token" });
    }

    if (!context) {
      await readBody(request);
      return json(response, 503, { error: "no active smoke scenario" });
    }

    const { observed, scenario } = context;
    const jobs = context.jobs ?? [context.job];

    if (request.method === "GET" && url.pathname === `/api/v1/nodes/${nodeId}/config`) {
      observed.configReads += 1;
      if (scenario.nodeConfigFailuresRemaining > 0) {
        scenario.nodeConfigFailuresRemaining -= 1;
        observed.nodeConfigFailures += 1;
        return json(response, 503, { error: "simulated node config failure" });
      }

      return json(response, 200, {
        data: {
          recordingCapacity: {
            maxConcurrentRecordings: scenario.concurrent ? 2 : 1,
          },
          recorderCachePolicies: recorderCachePoliciesForScenario(scenario),
        },
      });
    }

    if (
      request.method === "GET" &&
      url.pathname === `/api/v1/nodes/${nodeId}/recording-jobs/next`
    ) {
      observed.nextReads += 1;
      const job = nextQueuedJob(jobs);

      return job ? json(response, 200, { data: job }) : empty(response);
    }

    if (
      request.method === "POST" &&
      url.pathname === `/api/v1/nodes/${nodeId}/recording-jobs/claim-next`
    ) {
      observed.claimNextReads += 1;
      if (scenario.claimNextFailuresRemaining > 0) {
        scenario.claimNextFailuresRemaining -= 1;
        observed.claimNextReadFailures += 1;
        return json(response, 503, { error: "simulated claim-next failure" });
      }

      const job = nextQueuedJob(jobs);

      if (!job) {
        return empty(response);
      }

      observed.claims += 1;
      job.status = "running";
      rememberRunningJobs(observed, jobs);
      return json(response, 200, { data: job });
    }

    if (
      request.method === "POST" &&
      url.pathname === `/api/v1/nodes/${nodeId}/recording-jobs/claim-next-group`
    ) {
      observed.claimNextReads += 1;
      if (scenario.claimNextFailuresRemaining > 0) {
        scenario.claimNextFailuresRemaining -= 1;
        observed.claimNextReadFailures += 1;
        return json(response, 503, { error: "simulated claim-next failure" });
      }

      const primary = nextQueuedJob(jobs);

      if (!primary) {
        return empty(response);
      }

      // Claim the primary plus every queued sibling sharing its capture group so
      // the agent captures the shared device once and splits it per job.
      const groupId = primary.command?.captureGroupId;
      const members = groupId
        ? jobs.filter((job) => job.status === "queued" && job.command?.captureGroupId === groupId)
        : [primary];

      for (const member of members) {
        observed.claims += 1;
        member.status = "running";
      }
      rememberRunningJobs(observed, jobs);
      return json(response, 200, { data: members });
    }

    if (
      request.method === "GET" &&
      url.pathname === `/api/v1/nodes/${nodeId}/channel-map-assignments`
    ) {
      observed.channelMapReads += 1;
      if (scenario.channelMapFailuresRemaining-- > 0) {
        observed.channelMapFailures += 1;
        return json(response, 503, { error: "simulated channel-map failure" });
      }
      return json(response, 200, { data: scenario.channelMapAssignments ?? [] });
    }

    if (request.method === "POST" && url.pathname === `/api/v1/nodes/${nodeId}/heartbeat`) {
      await readBody(request);
      if (scenario.nodeHeartbeatFailuresRemaining > 0) {
        scenario.nodeHeartbeatFailuresRemaining -= 1;
        observed.nodeHeartbeatFailures += 1;
        return json(response, 503, { error: "simulated node heartbeat failure" });
      }

      observed.nodeHeartbeats += 1;
      if (scenario.nodeHeartbeatDateHeaders?.length > 0) {
        const index = Math.min(
          observed.nodeHeartbeats - 1,
          scenario.nodeHeartbeatDateHeaders.length - 1,
        );
        response.setHeader("date", scenario.nodeHeartbeatDateHeaders[index]());
      }
      return json(response, 202, { data: { ok: true } });
    }

    if (request.method === "POST" && url.pathname === `/api/v1/nodes/${nodeId}/inventory`) {
      const body = await readBody(request);
      observed.inventoryReconciles += 1;
      const interfaces = Array.isArray(body?.interfaces) ? body.interfaces : [];
      return json(response, 202, {
        data: {
          changed: true,
          node: { id: nodeId, interfaces },
          summary: { absent: [], added: [], reactivated: [], unchanged: 0, updated: [] },
        },
      });
    }

    if (request.method === "POST" && url.pathname === `/api/v1/nodes/${nodeId}/meter-frame`) {
      await readBody(request);
      if (scenario.meterFrameFailuresRemaining > 0) {
        scenario.meterFrameFailuresRemaining -= 1;
        observed.meterFrameFailures = (observed.meterFrameFailures ?? 0) + 1;
        return json(response, 503, { error: "simulated meter-frame failure" });
      }
      observed.meterFrames += 1;
      return json(response, 202, { data: { ok: true } });
    }

    if (request.method === "POST" && url.pathname === `/api/v1/nodes/${nodeId}/listen/chunk`) {
      const body = await readBody(request);
      if (scenario.monitorChunkFailuresRemaining > 0) {
        scenario.monitorChunkFailuresRemaining -= 1;
        observed.monitorChunkFailures += 1;
        return json(response, 503, { error: "simulated monitor chunk failure" });
      }

      observed.monitorChunks.push({
        capturedAt: request.headers["x-rakkr-captured-at"],
        contentType: request.headers["content-type"],
        durationMs: request.headers["x-rakkr-duration-ms"],
        size: body.byteLength,
      });
      return json(response, 202, { data: { ok: true } });
    }

    const claimMatch = url.pathname.match(/^\/api\/v1\/recording-jobs\/([^/]+)\/claim$/);

    if (request.method === "POST" && claimMatch) {
      const job = jobById(jobs, claimMatch[1]);

      if (!job) {
        await readBody(request);
        return json(response, 404, { error: "job not found" });
      }

      observed.claims += 1;
      job.status = "running";
      rememberRunningJobs(observed, jobs);
      return json(response, 200, { data: job });
    }

    const heartbeatMatch = url.pathname.match(/^\/api\/v1\/recording-jobs\/([^/]+)\/heartbeat$/);

    if (request.method === "POST" && heartbeatMatch) {
      const job = jobById(jobs, heartbeatMatch[1]);

      if (!job) {
        await readBody(request);
        return json(response, 404, { error: "job not found" });
      }

      observed.heartbeats += 1;
      if (scenario.jobHeartbeatFailuresRemaining > 0) {
        scenario.jobHeartbeatFailuresRemaining -= 1;
        observed.jobHeartbeatFailures += 1;
        return json(response, 503, { error: "simulated job heartbeat failure" });
      }

      return json(response, 200, { data: job });
    }

    const readMatch = url.pathname.match(/^\/api\/v1\/recording-jobs\/([^/]+)$/);

    if (request.method === "GET" && readMatch) {
      const job = jobById(jobs, readMatch[1]);

      if (!job) {
        return json(response, 404, { error: "job not found" });
      }

      observed.jobStatusReads += 1;
      if (scenario.jobStatusFailuresRemaining > 0) {
        scenario.jobStatusFailuresRemaining -= 1;
        observed.jobStatusReadFailures += 1;
        return json(response, 503, { error: "simulated job status failure" });
      }

      if (scenario.controllerStopRequested) {
        job.status = "stop_requested";
      }
      if (scenario.controllerTerminalStatus) {
        job.status = scenario.controllerTerminalStatus;
        job.failureReason = scenario.controllerTerminalReason;
      }

      return json(response, 200, { data: job });
    }

    const cancelledMatch = url.pathname.match(/^\/api\/v1\/recording-jobs\/([^/]+)\/cancelled$/);

    if (request.method === "POST" && cancelledMatch) {
      const job = jobById(jobs, cancelledMatch[1]);

      if (!job) {
        await readBody(request);
        return json(response, 404, { error: "job not found" });
      }

      observed.cancellations += 1;
      observed.cancelReason = request.headers["x-rakkr-reason"];
      job.failureReason = observed.cancelReason;
      job.status = "cancelled";
      return json(response, 200, { data: job });
    }

    const failedMatch = url.pathname.match(/^\/api\/v1\/recording-jobs\/([^/]+)\/failed$/);

    if (request.method === "POST" && failedMatch) {
      const job = jobById(jobs, failedMatch[1]);

      if (!job) {
        await readBody(request);
        return json(response, 404, { error: "job not found" });
      }

      observed.failures += 1;
      observed.failureReason = request.headers["x-rakkr-reason"];
      job.failureReason = observed.failureReason;
      job.status = "failed";
      return json(response, 200, { data: job });
    }

    if (request.method === "POST" && url.pathname === `/api/v1/nodes/${nodeId}/health-events`) {
      const event = JSON.parse((await readBody(request)).toString("utf8"));
      observed.healthEvents.push(event);
      return json(response, 201, { data: { id: `health_${observed.healthEvents.length}` } });
    }

    const cacheMatch = url.pathname.match(/^\/api\/v1\/recordings\/([^/]+)\/cache-file$/);

    if (request.method === "PUT" && cacheMatch) {
      const job = jobByRecordingId(jobs, cacheMatch[1]);

      if (!job) {
        await readBody(request);
        return json(response, 404, { error: "recording job not found" });
      }

      const body = await readBody(request);

      const upload = {
        contentType: request.headers["content-type"],
        durationSeconds: request.headers["x-rakkr-duration-seconds"],
        fileName: request.headers["x-rakkr-file-name"],
        jobId: request.headers["x-rakkr-recording-job-id"],
        recordingId: job.recordingId,
        size: body.byteLength,
      };
      observed.cacheUpload = upload;
      observed.cacheUploads.push(upload);

      if (scenario.cacheUploadFails) {
        return json(response, 503, { error: "simulated cache upload failure" });
      }

      job.status = "completed";

      return json(response, 201, { data: { ok: true } });
    }

    await readBody(request);
    return json(response, 404, { error: `unexpected route ${request.method} ${url.pathname}` });
  };
}

function nextQueuedJob(jobs) {
  return jobs.find((job) => job.status === "queued");
}

function jobById(jobs, jobId) {
  return jobs.find((job) => job.id === jobId);
}

function jobByRecordingId(jobs, recordingId) {
  return jobs.find((job) => job.recordingId === recordingId);
}

function rememberRunningJobs(observed, jobs) {
  observed.maxRunningJobs = Math.max(
    observed.maxRunningJobs,
    jobs.filter((job) => job.status === "running").length,
  );
}
