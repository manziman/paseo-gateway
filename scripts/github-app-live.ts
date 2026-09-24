import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { CoreV1Api } from "@kubernetes/client-node";
import { z } from "zod";
import { resourceName } from "../src/controller/resources.js";
import { API_GROUP } from "../src/domain.js";
import { KubernetesStore, loadKubernetesConfig } from "../src/kubernetes/client.js";

// Run only against an explicitly selected disposable workspace. This deliberately
// advances broker renewal metadata; it never revokes the installation or App key.
const schema = z
  .object({
    context: z.string().min(1),
    namespace: z.string().min(1),
    workspace: z.string().min(1),
    forceRenewal: z.literal(true),
    timeoutSeconds: z.number().int().min(30).max(600).default(240),
  })
  .strict();
const [file, reportPath] = process.argv.slice(2);
if (!file || !reportPath)
  throw new Error("Usage: node --import tsx scripts/github-app-live.ts CONFIG.json REPORT.json");
const checks: { check: string; status: "passed" | "failed" | "blocked"; reason?: string }[] = [];
try {
  const config = schema.parse(JSON.parse(await readFile(file, "utf8")));
  const cluster = loadKubernetesConfig(config.context);
  const store = new KubernetesStore(cluster, config.namespace);
  const api = cluster.makeApiClient(CoreV1Api);
  const workspace = (await store.workspaces()).find(
    (row) => row.metadata.name === config.workspace,
  );
  assert.ok(workspace?.status?.phase === "Ready");
  const profile = await store.credentialProfile(workspace.spec.credentialProfile);
  const app = profile?.spec.git?.githubApp;
  if (!app) {
    checks.push({
      check: "github-app-live",
      status: "blocked",
      reason: "ExplicitGitHubAppWorkspaceRequired",
    });
  } else {
    const podName = resourceName(workspace);
    const initialPod = await api.readNamespacedPod({ namespace: config.namespace, name: podName });
    const execute = promisify(execFile);
    const inPod = async (args: string[]) =>
      (
        await execute(
          "kubectl",
          [
            "--context",
            config.context,
            "-n",
            config.namespace,
            "exec",
            podName,
            "-c",
            "daemon",
            "--",
            ...args,
          ],
          { timeout: 30000, maxBuffer: 1024 * 1024 },
        )
      ).stdout;
    const tokenDigest = () =>
      inPod([
        "node",
        "-e",
        "const f=require('node:fs'),c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(f.readFileSync('/run/paseo-git/token')).digest('hex'))",
      ]);
    const beforeDigest = await tokenDigest();
    const before = await store.readSecret(app.outputSecretName);
    assert.ok(before?.data?.token);
    assert.equal(
      before.metadata?.annotations?.[`${API_GROUP}/broker-profile`],
      `${profile.metadata.namespace}/${profile.metadata.name}/${profile.metadata.uid ?? ""}`,
    );
    const scope = (
      await inPod(["gh", "api", "installation/repositories", "--jq", ".repositories[].full_name"])
    )
      .trim()
      .split("\n");
    assert.ok(
      scope.length > 0 &&
        scope.every((repo) =>
          app.repositories.some((allowed) => allowed.toLowerCase() === repo.toLowerCase()),
        ),
    );
    checks.push({ check: "installation-token-repository-scope", status: "passed" });
    await inPod(["git", "ls-remote", "--heads", "origin"]);
    checks.push({ check: "running-worker-private-git-fetch", status: "passed" });
    const requested = structuredClone(before);
    requested.metadata = {
      ...requested.metadata,
      annotations: {
        ...requested.metadata?.annotations,
        [`${API_GROUP}/broker-expires-at`]: new Date().toISOString(),
      },
    };
    assert.ok(
      await store.compareAndSwapSecret(
        app.outputSecretName,
        before.metadata?.resourceVersion,
        requested,
      ),
    );
    const deadline = Date.now() + config.timeoutSeconds * 1000;
    let renewed = false;
    while (Date.now() < deadline) {
      const current = await store.readSecret(app.outputSecretName);
      if (
        current?.data?.token &&
        current.data.token !== before.data.token &&
        (await tokenDigest()) !== beforeDigest
      ) {
        renewed = true;
        break;
      }
      await delay(2000);
    }
    assert.ok(renewed);
    const afterPod = await api.readNamespacedPod({ namespace: config.namespace, name: podName });
    assert.equal(afterPod.metadata?.uid, initialPod.metadata?.uid);
    assert.deepEqual(
      afterPod.status?.containerStatuses?.map((entry) => entry.restartCount),
      initialPod.status?.containerStatuses?.map((entry) => entry.restartCount),
    );
    await inPod(["git", "ls-remote", "--heads", "origin"]);
    await inPod(["gh", "api", "installation/repositories", "--jq", ".total_count"]);
    checks.push({
      check: "live-native-renewal-and-worker-volume-consumption-without-restart",
      status: "passed",
    });
    checks.push({
      check: "private-commit-push-draft-pr",
      status: "blocked",
      reason: "RunPrivateLiveWithThisAppProfileAndLinkSeparateEvidence",
    });
    checks.push({
      check: "actual-expiry-revocation",
      status: "blocked",
      reason: "RenewalWasRequestedBeforeActualTokenExpiry",
    });
  }
} catch {
  checks.push({
    check: "github-app-live",
    status: "failed",
    reason: "AcceptanceFailedDetailsRedacted",
  });
}
await writeFile(
  reportPath,
  JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), checks }, null, 2),
  { mode: 0o600 },
);
process.exitCode = checks.some((row) => row.status === "failed")
  ? 1
  : checks.some((row) => row.status === "blocked")
    ? 2
    : 0;
console.log(
  JSON.stringify({
    passed: checks.filter((row) => row.status === "passed").length,
    failed: checks.filter((row) => row.status === "failed").length,
    blocked: checks.filter((row) => row.status === "blocked").length,
  }),
);
