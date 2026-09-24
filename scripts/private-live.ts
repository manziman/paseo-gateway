import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resourceName } from "../src/controller/resources.js";
import { scopedId, workspacePath } from "../src/domain.js";
import { KubernetesStore, loadKubernetesConfig } from "../src/kubernetes/client.js";
import { context, namespace } from "./local-config.js";

// Explicitly opt in: this suite pushes a dedicated branch and opens a draft PR.
if (process.env.RUN_PRIVATE_LIVE !== "1")
  throw new Error(
    "Set RUN_PRIVATE_LIVE=1 after selecting an authorized test repository and project",
  );
const repository = process.env.PASEO_TEST_REPOSITORY;
const projectId = process.env.PASEO_TEST_PROJECT;
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !projectId)
  throw new Error("Set PASEO_TEST_REPOSITORY=owner/repo and PASEO_TEST_PROJECT");
const store = new KubernetesStore(loadKubernetesConfig(context), namespace);
const encoded = (await store.secret("paseo-identity")).data?.password;
if (!encoded) throw new Error("Gateway identity is unavailable");
const password = Buffer.from(encoded, "base64").toString("utf8");
const suffix = randomUUID().slice(0, 8);
const branch = `paseo-gateway-acceptance/${suffix}`;
const marker = `gateway-acceptance-${suffix}`;
let proxy: ChildProcess | undefined;
let client: DaemonClient | undefined;
let scheduleToPause: string | undefined;
const resumeWorkspace = process.env.PASEO_TEST_WORKSPACE;
const execute = promisify(execFile);
async function inPod(pod: string, command: string[]) {
  try {
    const result = await execute(
      "kubectl",
      ["--context", context, "-n", namespace, "exec", pod, "-c", "daemon", "--", ...command],
      { timeout: 240000, maxBuffer: 1024 * 1024 },
    );
    return result.stdout.trim();
  } catch {
    throw new Error(`Workspace command failed (${command[0]}); inspect its protected logs`);
  }
}
async function eventually<T>(read: () => Promise<T | undefined>, label: string) {
  for (let i = 0; i < 240; i++) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(2000);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  proxy = spawn(
    "kubectl",
    [
      "--context",
      context,
      "-n",
      namespace,
      "port-forward",
      "--address",
      "127.0.0.1",
      "service/paseo-gateway",
      ":8080",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Port-forward failed")), 15000);
    proxy?.stdout?.on("data", (chunk: Buffer) => {
      const match = /127\.0\.0\.1:(\d+)/.exec(chunk.toString());
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    proxy?.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Cannot start port-forward"));
    });
  });
  const active = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    password,
    clientId: randomUUID(),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  client = active;
  await active.connect();
  const response = resumeWorkspace
    ? { workspace: { id: resumeWorkspace }, error: null }
    : await active.createWorkspace({
        title: `Private acceptance ${suffix}`,
        source: {
          kind: "worktree",
          projectId,
          action: "branch-off",
          baseBranch: "origin/main",
          branchName: branch,
        },
      });
  if (!response.workspace) throw new Error(response.error ?? "Workspace creation failed");
  const workspace = await eventually(async () => {
    const row = (await store.workspaces()).find(
      (row) => row.metadata.name === response.workspace?.id,
    );
    if (row?.status?.phase === "Failed") throw new Error(row.status.message);
    return row?.status?.phase === "Ready" ? row : undefined;
  }, "private clone readiness");
  const pod = resourceName(workspace);
  let pr: string | undefined;
  if (!resumeWorkspace) {
    assert.equal(await inPod(pod, ["git", "branch", "--show-current"]), branch);
    const testFile = `.paseo-gateway-acceptance-${suffix}.txt`;
    await inPod(pod, [
      "node",
      "-e",
      "require('node:fs').writeFileSync(process.argv[1],process.argv[2]+'\\n')",
      testFile,
      marker,
    ]);
    await inPod(pod, ["git", "add", "--", testFile]);
    await inPod(pod, ["git", "commit", "-m", `test: isolated gateway acceptance ${suffix}`]);
    await inPod(pod, ["git", "push", "origin", `HEAD:refs/heads/${branch}`]);
    pr = await inPod(pod, [
      "gh",
      "pr",
      "create",
      "--repo",
      repository,
      "--draft",
      "--head",
      branch,
      "--title",
      `Gateway acceptance test ${suffix}`,
      "--body",
      "Disposable acceptance artifact for the independently maintained Kubernetes gateway. This tests private clone, projected Git identity, branch push, and draft PR creation. No application behavior changes.",
    ]);
    assert.match(pr, /https:\/\/github.com\/[^/]+\/[^/]+\/pull\/\d+/);
    console.log(`PASS private clone, branch, commit, push and draft PR: ${pr}`);
    console.log(`Retained private test workspace: ${workspace.metadata.name}`);
  } else {
    assert.equal(workspace.spec.projectRef, projectId);
    console.log(`Resuming workflow checks in ${workspace.metadata.name}; initial Git test skipped`);
  }
  const command = `/opt/paseo/bin/paseo run --provider claude --mode bypassPermissions --background --json --label acceptance=${suffix} --env GATEWAY_ACCEPTANCE_ID=${marker}-worker 'Use Bash to print only the environment variable GATEWAY_ACCEPTANCE_ID. Reply with only its value. Do not modify files or read other environment variables.'`;
  const orchestrator = await active.createAgent({
    config: {
      provider: "claude",
      cwd: workspacePath(workspace.metadata.name),
      modeId: "bypassPermissions",
    },
    workspaceId: workspace.metadata.name,
    initialPrompt: `This is an authorized platform integration test. Use your Bash tool to run this exact command once: ${command}. Allow up to 360 seconds for a cold clone. Do not retry if the outcome is unclear. Read the returned agentId, then run /opt/paseo/bin/paseo wait with that exact ID, --timeout 180 and --json. Return the worker result. Do not edit repository files or run any other commands.`,
  });
  console.log(`Orchestrator started: ${orchestrator.id}`);
  const orchestratorResult = await active.waitForFinish(orchestrator.id, 480000);
  assert.equal(orchestratorResult.status, "idle", "Orchestrator must finish without error");
  const inventory = await active.fetchAgents({
    filter: { projectKeys: [projectId], labels: { acceptance: suffix } },
  });
  assert.equal(inventory.entries.length, 1, "Orchestrator must create exactly one labeled worker");
  const worker = inventory.entries[0]?.agent;
  assert.ok(worker);
  assert.ok(
    !worker.id.startsWith(`${workspace.metadata.name}~`),
    "Worker must use another workspace pod",
  );
  const finished = await active.waitForFinish(worker.id, 180000);
  assert.equal(finished.status, "idle");
  assert.ok(finished.lastMessage?.includes(`${marker}-worker`));
  assert.ok(
    orchestratorResult.lastMessage?.includes(`${marker}-worker`),
    "Orchestrator must read its worker result",
  );
  const orchestrationTimeline = await active.fetchAgentTimeline(orchestrator.id);
  assert.ok(
    orchestrationTimeline.entries.some(
      ({ item }) =>
        item.type === "tool_call" &&
        item.status === "completed" &&
        JSON.stringify(item.detail).includes("/opt/paseo/bin/paseo wait"),
    ),
    "Orchestrator must invoke CLI wait through its tool interface",
  );
  console.log(
    "PASS Claude orchestrator used scoped in-pod CLI to spawn and wait for a separate worker pod",
  );
  const scheduledBranch = `${branch}-scheduled`;
  const scheduledFile = `.paseo-gateway-scheduled-${suffix}.txt`;
  const workerTask = `This is an authorized integration test in ${repository}. Use Bash to write exactly ${marker}-scheduled and a newline into ${scheduledFile}. Commit only that file with message gateway acceptance ${suffix}. Push the current branch ${scheduledBranch} to origin, then use gh pr create --repo ${repository} --draft --head ${scheduledBranch} with title Gateway scheduled acceptance ${suffix} and body Disposable platform acceptance marker, no application behavior changes. Return the draft PR URL. Do not modify any other files, merge anything, install dependencies, or run project hooks.`;
  const scheduledCommand = `/opt/paseo/bin/paseo run --provider claude --mode bypassPermissions --background --json --label acceptance=scheduled-${suffix} --new-workspace worktree --cwd /projects/${projectId} --new-branch ${scheduledBranch} --base origin/main '${workerTask}'`;
  const created = await active.scheduleCreate({
    name: `Acceptance ${suffix}`,
    prompt: `This is an authorized platform integration test. Use Bash to run this exact command once: ${scheduledCommand}. Allow 360 seconds for the cold clone. Do not retry an uncertain creation. Read the returned agentId and use /opt/paseo/bin/paseo wait with that ID, --timeout 240 and --json to wait for the worker. Return its draft PR URL. Do not edit files yourself or run other commands.`,
    cadence: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
    target: {
      type: "new-agent",
      config: { provider: "claude", cwd: `/projects/${projectId}`, modeId: "bypassPermissions" },
    },
  });
  assert.ok(created.schedule, created.error ?? "Schedule creation failed");
  const scheduleId = created.schedule.id;
  scheduleToPause = scheduleId;
  console.log(`Schedule created: ${scheduleId}`);
  await active.scheduleRunOnce({ id: scheduleId });
  const run = await eventually(async () => {
    const logs = await active.scheduleLogs({ id: scheduleId });
    const latest = logs.runs[0];
    if (latest?.status === "failed") throw new Error(latest.error ?? "Schedule failed");
    return latest?.status === "succeeded" ? latest : undefined;
  }, "scheduled run and archive");
  assert.ok(run.workspaceId && run.agentId);
  const archivedAgentId = scopedId(run.workspaceId, run.agentId);
  const archivedInventory = await active.fetchAgents({
    filter: { projectKeys: [projectId], includeArchived: true },
  });
  assert.ok(
    archivedInventory.entries.some((entry) => entry.agent.id === archivedAgentId),
    "Archived scheduled agent remains listed",
  );
  const scheduledWorkers = await active.fetchAgents({
    filter: { projectKeys: [projectId], labels: { acceptance: `scheduled-${suffix}` } },
  });
  assert.equal(scheduledWorkers.entries.length, 1, "Scheduled orchestrator must create one worker");
  const scheduledWorker = scheduledWorkers.entries[0]?.agent;
  assert.ok(scheduledWorker && !scheduledWorker.id.startsWith(`${run.workspaceId}~`));
  const scheduledResult = await active.waitForFinish(scheduledWorker.id, 30000);
  assert.equal(scheduledResult.status, "idle");
  const scheduledPr = scheduledResult.lastMessage?.match(
    /https:\/\/github.com\/[^/]+\/[^/]+\/pull\/\d+/,
  )?.[0];
  assert.ok(scheduledPr, "Scheduled worker must return a PR URL");
  assert.ok(
    scheduledPr.startsWith(`https://github.com/${repository}/pull/`),
    "Scheduled worker must return authorized-repository PR",
  );
  const scheduledWorkspaceId = scheduledWorker.id.split("~")[0];
  const scheduledWorkspace = (await store.workspaces()).find(
    (entry) => entry.metadata.name === scheduledWorkspaceId,
  );
  assert.ok(scheduledWorkspace);
  const scheduledPod = resourceName(scheduledWorkspace);
  assert.equal(await inPod(scheduledPod, ["git", "branch", "--show-current"]), scheduledBranch);
  assert.equal(
    await inPod(scheduledPod, ["git", "show", "--pretty=", "--name-only", "HEAD"]),
    scheduledFile,
  );
  const prState = JSON.parse(
    await inPod(scheduledPod, [
      "gh",
      "pr",
      "view",
      scheduledPr,
      "--repo",
      repository,
      "--json",
      "isDraft,headRefName,state",
    ]),
  ) as { isDraft: boolean; headRefName: string; state: string };
  assert.deepEqual(prState, { isDraft: true, headRefName: scheduledBranch, state: "OPEN" });
  assert.equal((await active.schedulePause({ id: scheduleId })).error, null);
  console.log(
    `PASS scheduled orchestrator spawned private worker, committed marker and opened draft PR: ${scheduledPr}`,
  );
  console.log(
    `PASS schedule run, completion, teardown, archived inventory; schedule paused: ${created.schedule.id}`,
  );
  if (pr) console.log(`Draft PR retained for inspection: ${pr}`);
} finally {
  if (scheduleToPause && client) {
    let pausedSuccessfully = false;
    try {
      const paused = await client.schedulePause({ id: scheduleToPause });
      pausedSuccessfully = !paused.error;
    } catch {}
    if (!pausedSuccessfully) {
      process.exitCode = 1;
      console.error(
        `Could not pause acceptance schedule ${scheduleToPause}; pause it before leaving the test unattended`,
      );
    }
  }
  await client?.close();
  proxy?.kill();
}
