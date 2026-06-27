const runnerUrl = process.env.RAKKR_ANSIBLE_RUNNER_URL ?? "http://127.0.0.1:8790";
const actions = (
  process.env.RAKKR_ANSIBLE_SMOKE_SEQUENCE ??
  process.env.RAKKR_ANSIBLE_SMOKE_ACTION ??
  "smoke_check"
)
  .split(",")
  .map((action) => action.trim())
  .filter(Boolean);
const host = process.env.RAKKR_ANSIBLE_SMOKE_HOST ?? "recorder-test-rig";
const nodeId = process.env.RAKKR_ANSIBLE_SMOKE_NODE_ID ?? "node_x32_test";
const nodeAlias = process.env.RAKKR_ANSIBLE_SMOKE_NODE_ALIAS ?? "Council Chamber Rack";
const sshUser = process.env.RAKKR_ANSIBLE_SMOKE_SSH_USER;
const agentVersion = process.env.RAKKR_ANSIBLE_SMOKE_AGENT_VERSION;

if (actions.length === 0) {
  console.error("No Ansible lifecycle smoke actions were requested");
  process.exit(1);
}

for (const action of actions) {
  const payload = {
    action,
    target: {
      host,
      nodeAlias,
      nodeId,
    },
    options: {
      ...(agentVersion ? { agentVersion } : {}),
      ...(sshUser ? { sshUser } : {}),
    },
  };

  const response = await fetch(`${runnerUrl.replace(/\/$/, "")}/runs`, {
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error(`Ansible runner request failed: ${response.status}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  const result = body.data;

  if (!result || typeof result.exitCode !== "number") {
    console.error("Ansible runner returned an invalid response");
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        action,
        exitCode: result.exitCode,
        runId: result.runId,
        targetHost: result.targetHost,
      },
      null,
      2,
    ),
  );

  if (result.stdout) {
    console.log(result.stdout);
  }

  if (result.stderr) {
    console.error(result.stderr);
  }

  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}
