import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { CoreV1Api } from "@kubernetes/client-node";
import { resourceName } from "../src/controller/resources.js";
import { API_GROUP } from "../src/domain.js";
import { KubernetesStore, loadKubernetesConfig } from "../src/kubernetes/client.js";
import { GitHubAppAcceptanceConfigSchema as schema } from "./github-app-acceptance-config.js";
import { installationTokenStatusScript } from "./github-app-probe.js";

// Run only against an explicitly selected disposable workspace. This deliberately
// advances broker renewal metadata; it never revokes the installation or App key.
const [file, reportPath] = process.argv.slice(2);
if (!file || !reportPath)
  throw new Error("Usage: node --import tsx scripts/github-app-live.ts CONFIG.json REPORT.json");
const checks: {
  check: string;
  status: "passed" | "failed" | "blocked" | "skipped";
  reason?: string;
}[] = [];
let stage = "configuration";
const imageDigests = new Set<string>();
const gatewayImageDigests = new Set<string>();
const artifacts: Record<string, unknown> = {};
try {
  const config = schema.parse(JSON.parse(await readFile(file, "utf8")));
  Object.assign(artifacts, {
    context: config.context,
    namespace: config.namespace,
    workspace: config.workspace,
    cleanup: "inspection-required",
  });
  const cluster = loadKubernetesConfig(config.context);
  const store = new KubernetesStore(cluster, config.namespace);
  const api = cluster.makeApiClient(CoreV1Api);
  const gatewayPods = await api.listNamespacedPod({
    namespace: config.namespace,
    labelSelector: "app.kubernetes.io/component=gateway",
  });
  for (const pod of gatewayPods.items)
    for (const status of pod.status?.containerStatuses ?? []) {
      const digest = /sha256:[a-f0-9]{64}/.exec(status.imageID)?.[0];
      if (digest) gatewayImageDigests.add(digest);
    }
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
    for (const status of initialPod.status?.containerStatuses ?? []) {
      const digest = /sha256:[a-f0-9]{64}/.exec(status.imageID)?.[0];
      if (digest) imageDigests.add(digest);
    }
    assert.equal(initialPod.spec?.automountServiceAccountToken, false);
    assert.ok(!JSON.stringify(initialPod.spec).includes(app.privateKeySecretRef.name));
    checks.push({ check: "worker-no-app-private-key-or-kubernetes-token", status: "passed" });
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
    stage = "scope";
    const beforeDigest = await tokenDigest();
    const before = await store.readSecret(app.outputSecretName);
    assert.ok(before?.data?.token);
    assert.equal(
      before.metadata?.annotations?.[`${API_GROUP}/broker-profile`],
      `${profile.metadata.namespace}/${profile.metadata.name}/${profile.metadata.uid ?? ""}`,
    );
    const scope = (
      await inPod([
        "gh",
        "api",
        "installation/repositories",
        "--paginate",
        "--jq",
        ".repositories[].full_name",
      ])
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
    if (config.privateWrite) {
      stage = "private-write";
      const repository = config.privateWrite.repository;
      assert.ok(
        app.repositories.some((allowed) => allowed.toLowerCase() === repository.toLowerCase()),
      );
      const remote = (await inPod(["git", "remote", "get-url", "origin"])).trim();
      assert.equal(
        remote.replace(/\.git$/, "").toLowerCase(),
        `https://github.com/${repository}`.toLowerCase(),
      );
      assert.equal((await inPod(["git", "status", "--porcelain"])).trim(), "");
      const suffix = randomUUID().slice(0, 8);
      const branch = `paseo-gateway-acceptance/${suffix}`;
      const markerFile = `.paseo-gateway-acceptance-${suffix}.txt`;
      await inPod(["git", "switch", "-c", branch]);
      await inPod([
        "node",
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],'Disposable gateway acceptance marker\\n')",
        markerFile,
      ]);
      // Repositories may ignore dotfiles; force only this newly generated marker.
      await inPod(["git", "add", "--force", "--", markerFile]);
      stage = "private-commit";
      await inPod([
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        `test: isolated gateway acceptance ${suffix}`,
      ]);
      assert.equal(
        (await inPod(["git", "show", "--pretty=", "--name-only", "HEAD"])).trim(),
        markerFile,
      );
      assert.equal(
        (await inPod(["git", "log", "-1", "--format=%an"])).trim(),
        profile.spec.git?.identity?.name,
      );
      stage = "private-push";
      await inPod([
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "origin",
        `HEAD:refs/heads/${branch}`,
      ]);
      stage = "draft-pr-create";
      const url = (
        await inPod([
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
          "Disposable infrastructure acceptance artifact for an independently maintained Kubernetes gateway. Tests private clone, projected identity, branch push and draft PR creation. No application behavior changes.",
        ])
      ).trim();
      assert.ok(url.startsWith(`https://github.com/${repository}/pull/`));
      stage = "draft-pr-verify";
      const state = JSON.parse(
        await inPod([
          "gh",
          "pr",
          "view",
          url,
          "--repo",
          repository,
          "--json",
          "isDraft,headRefName,state",
        ]),
      );
      assert.deepEqual(state, { headRefName: branch, isDraft: true, state: "OPEN" });
      Object.assign(artifacts, { workspace: config.workspace, branch, draftPullRequest: url });
      checks.push({ check: "private-commit-push-draft-pr", status: "passed" });
    } else
      checks.push({
        check: "private-commit-push-draft-pr",
        status: "blocked",
        reason: "PrivateWriteNotSelected",
      });
    stage = "renewal";
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
    if (config.revokeNewlyMintedToken) {
      stage = "disposable-token-revocation";
      // The only revocable token is the newly minted output observed by this run.
      // A shared live profile would affect other workers, so refuse that fixture.
      const consumers = (await store.workspaces()).filter(
        (row) =>
          row.spec.credentialProfile === profile.metadata.name && row.spec.residency === "Running",
      );
      assert.deepEqual(
        consumers.map((row) => row.metadata.name),
        [config.workspace],
      );
      const renewedSecret = await store.readSecret(app.outputSecretName);
      assert.ok(renewedSecret?.data?.token && renewedSecret.data.token !== before.data.token);
      const revocableDigest = createHash("sha256")
        .update(Buffer.from(renewedSecret.data.token, "base64"))
        .digest("hex");
      const requestStatus = async (method: string, path: string) =>
        Number(
          (
            await inPod([
              "node",
              "-e",
              installationTokenStatusScript,
              method,
              path,
              revocableDigest,
              "/run/paseo-git/token",
            ])
          ).trim(),
        );
      assert.equal(await requestStatus("DELETE", "installation/token"), 204);
      assert.equal(await requestStatus("GET", "installation/repositories"), 401);
      let gitRejected = false;
      try {
        await inPod(["git", "ls-remote", "--heads", "origin"]);
      } catch {
        gitRejected = true;
      }
      assert.ok(gitRejected);
      checks.push({
        check: "disposable-installation-token-revoked-and-rejected",
        status: "passed",
      });
      stage = "revocation-recovery";
      const revokedDigest = await tokenDigest();
      const replace = structuredClone(renewedSecret);
      assert.ok(replace.metadata);
      replace.metadata.annotations = {
        ...replace.metadata.annotations,
        [`${API_GROUP}/broker-expires-at`]: new Date().toISOString(),
      };
      assert.ok(
        await store.compareAndSwapSecret(
          app.outputSecretName,
          renewedSecret.metadata?.resourceVersion,
          replace,
        ),
      );
      let recovered = false;
      const recoveryDeadline = Date.now() + config.timeoutSeconds * 1000;
      while (Date.now() < recoveryDeadline) {
        const current = await store.readSecret(app.outputSecretName);
        if (
          current?.data?.token &&
          current.data.token !== renewedSecret.data.token &&
          (await tokenDigest()) !== revokedDigest
        ) {
          recovered = true;
          break;
        }
        await delay(2000);
      }
      assert.ok(recovered);
      await inPod(["git", "ls-remote", "--heads", "origin"]);
      assert.equal(await requestStatus("GET", "installation/repositories"), 200);
      const recoveredPod = await api.readNamespacedPod({
        namespace: config.namespace,
        name: podName,
      });
      assert.equal(recoveredPod.metadata?.uid, initialPod.metadata?.uid);
      assert.deepEqual(
        recoveredPod.status?.containerStatuses?.map((entry) => entry.restartCount),
        initialPod.status?.containerStatuses?.map((entry) => entry.restartCount),
      );
      checks.push({
        check: "revoked-token-replaced-and-worker-access-recovered-without-restart",
        status: "passed",
      });
    } else
      checks.push({
        check: "actual-token-revocation",
        status: "blocked",
        reason: "DisposableTokenRevocationNotSelected",
      });
    checks.push({
      check: "actual-time-expiry",
      status: "skipped",
      reason: "EarlyRenewalAndRevocationAreSeparateFromWaitingForExpiry",
    });
    if (config.suspendAfter) {
      await store.setResidency(workspace, "Suspended");
      artifacts.cleanup = "suspend-requested-pvc-retained";
    }
  }
} catch {
  checks.push({
    check: "github-app-live",
    status: "failed",
    reason: `AcceptanceFailed:${stage}`,
  });
}
await writeFile(
  reportPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      imageDigests: [...imageDigests],
      gatewayImageDigests: [...gatewayImageDigests],
      checks,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
await writeFile(`${reportPath}.cleanup-private.json`, JSON.stringify(artifacts, null, 2), {
  mode: 0o600,
});
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
    skipped: checks.filter((row) => row.status === "skipped").length,
  }),
);
