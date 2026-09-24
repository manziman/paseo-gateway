import { spawnSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { V1Secret } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { desiredResources } from "../src/controller/resources.js";
import { type BrokerSecretStore, GitHubAppBroker } from "../src/credentials/github-app.js";
import { API_GROUP, API_VERSION, CredentialProfileSchema } from "../src/domain.js";
import { project, workspace } from "./fixtures.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const profile = () =>
  CredentialProfileSchema.parse({
    apiVersion: API_VERSION,
    kind: "PaseoCredentialProfile",
    metadata: { name: "claude-default", namespace: "test", uid: "profile-1" },
    spec: {
      git: {
        githubApp: {
          appId: 123,
          installationId: 456,
          privateKeySecretRef: { name: "app-private", key: "pem" },
          outputSecretName: "app-token",
          repositories: ["octocat/Hello-World"],
        },
      },
    },
  });
const annotation = (key: string) => `${API_GROUP}/broker-${key}`;
class SecretStore implements BrokerSecretStore {
  objects = new Map<string, V1Secret>([
    [
      "app-private",
      {
        data: {
          pem: Buffer.from(keys.privateKey.export({ format: "pem", type: "pkcs8" })).toString(
            "base64",
          ),
        },
      },
    ],
  ]);
  version = 0;
  async readSecret(name: string) {
    const value = this.objects.get(name);
    return value ? structuredClone(value) : undefined;
  }
  async compareAndSwapSecret(name: string, version: string | undefined, secret: V1Secret) {
    const current = this.objects.get(name);
    if (current ? current.metadata?.resourceVersion !== version : version !== undefined)
      return false;
    if (current && version === undefined) return false;
    this.objects.set(name, {
      ...structuredClone(secret),
      metadata: { ...secret.metadata, resourceVersion: String(++this.version) },
    });
    return true;
  }
}
function response(now: number, token = "fixture-installation-token") {
  return new Response(
    JSON.stringify({
      token,
      expires_at: new Date(now + 3600000).toISOString(),
      repositories: [{ full_name: "octocat/Hello-World" }],
    }),
    { status: 201 },
  );
}
describe("GitHub App renewal authority", () => {
  it("signs a short-lived RS256 JWT, bounds scopes, and avoids disclosing private credentials", async () => {
    const store = new SecretStore();
    const now = Date.parse("2026-09-24T00:00:00Z");
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const header = new Headers(init?.headers).get("Authorization")?.slice(7) ?? "";
      const [head, body, signature] = header.split(".");
      expect(JSON.parse(Buffer.from(head ?? "", "base64url").toString())).toEqual({
        alg: "RS256",
        typ: "JWT",
      });
      expect(JSON.parse(Buffer.from(body ?? "", "base64url").toString())).toEqual({
        iat: now / 1000 - 60,
        exp: now / 1000 + 540,
        iss: "123",
      });
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${head}.${body}`),
          keys.publicKey,
          Buffer.from(signature ?? "", "base64url"),
        ),
      ).toBe(true);
      expect(JSON.parse(String(init?.body))).toEqual({
        repositories: ["Hello-World"],
        permissions: { contents: "write", pull_requests: "write" },
      });
      return response(now);
    });
    const broker = new GitHubAppBroker(store, { fetch: request, now: () => now });
    const result = await broker.reconcile([profile()]);
    expect(result[0]?.state).toBe("Renewed");
    expect(request.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/app/installations/456/access_tokens",
    );
    expect(JSON.stringify(result)).not.toContain("fixture-installation-token");
    expect(await broker.reconcile([profile()])).toEqual([
      expect.objectContaining({ state: "Ready" }),
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    const token = store.objects.get("app-token");
    expect(Object.keys(token?.data ?? {})).toEqual(["token"]);
    expect(token?.metadata?.annotations?.[annotation("lock-id")]).toBeUndefined();
  });
  it("allows only one gateway replica to mint at a time", async () => {
    const store = new SecretStore();
    const now = Date.now();
    const request = vi.fn<typeof fetch>(async () => response(now));
    const a = new GitHubAppBroker(store, { fetch: request, now: () => now, ownerId: "a" });
    const b = new GitHubAppBroker(store, { fetch: request, now: () => now, ownerId: "b" });
    await Promise.all([a.reconcile([profile()]), b.reconcile([profile()])]);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("renews early and keeps backoff durable and sanitized across restarts", async () => {
    const store = new SecretStore();
    let now = Date.now();
    const request = vi.fn<typeof fetch>(async () => response(now));
    const broker = new GitHubAppBroker(store, { fetch: request, now: () => now });
    await broker.reconcile([profile()]);
    now += 56 * 60_000;
    request.mockImplementation(
      async () => new Response("sensitive-upstream-error-body", { status: 403 }),
    );
    const failed = await broker.reconcile([profile()]);
    expect(failed[0]).toMatchObject({ state: "Backoff", reason: "GitHubHTTP403" });
    expect(JSON.stringify(failed)).not.toContain("sensitive-upstream-error-body");
    await new GitHubAppBroker(store, { fetch: request, now: () => now }).reconcile([profile()]);
    expect(request).toHaveBeenCalledTimes(2);
    now += 5001;
    request.mockImplementation(async () => response(now, "rotated-token"));
    expect((await broker.reconcile([profile()]))[0]?.state).toBe("Renewed");
    expect(
      Buffer.from(store.objects.get("app-token")?.data?.token ?? "", "base64").toString(),
    ).toBe("rotated-token");
  });
  it("caps repeated failure delays and refuses invalid signing keys without calling GitHub", async () => {
    const store = new SecretStore();
    store.objects.set("app-private", {
      data: { pem: Buffer.from("not-a-private-key").toString("base64") },
    });
    let now = Date.now();
    const request = vi.fn<typeof fetch>(async () => response(now));
    const broker = new GitHubAppBroker(store, { fetch: request, now: () => now });
    const delays: number[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = (await broker.reconcile([profile()]))[0];
      expect(result?.reason).toBe("PrivateKeyInvalid");
      const next = Date.parse(result?.nextAttempt ?? "");
      delays.push(next - now);
      now = next + 1;
    }
    expect(delays.slice(0, 3)).toEqual([5000, 10000, 20000]);
    expect(delays.at(-1)).toBe(300000);
    expect(request).not.toHaveBeenCalled();
  });
  it("does not overwrite an unrelated output Secret or publish after losing its lease", async () => {
    const store = new SecretStore();
    const now = Date.now();
    store.objects.set("app-token", { data: { unrelated: "do-not-touch" } });
    const request = vi.fn<typeof fetch>(async () => response(now));
    const broker = new GitHubAppBroker(store, { fetch: request, now: () => now });
    expect((await broker.reconcile([profile()]))[0]?.reason).toBe("OutputSecretAlreadyOwned");
    expect(request).not.toHaveBeenCalled();
    store.objects.delete("app-token");
    request.mockImplementation(async () => {
      const current = store.objects.get("app-token");
      if (current?.metadata?.annotations)
        current.metadata.annotations[annotation("lock-id")] = "another-holder";
      return response(now);
    });
    expect((await broker.reconcile([profile()]))[0]?.reason).toBe("RenewalLeaseLost");
    expect(store.objects.get("app-token")?.data?.token).toBeUndefined();
  });
  it("rejects out-of-scope token responses and clears a previously broader token when configuration changes", async () => {
    const store = new SecretStore();
    const now = Date.now();
    const request = vi.fn<typeof fetch>(async () => response(now));
    const broker = new GitHubAppBroker(store, { fetch: request, now: () => now });
    await broker.reconcile([profile()]);
    const changed = profile();
    if (!changed.spec.git?.githubApp) throw new Error("Missing app");
    changed.spec.git.githubApp.repositories = ["octocat/another"];
    expect((await broker.reconcile([changed]))[0]?.reason).toBe("RepositoryScopeMismatch");
    expect(store.objects.get("app-token")?.data?.token).toBe("");
    expect((await broker.reconcile([changed]))[0]?.state).toBe("Backoff");
  });
  it("projects only live installation token files, never the App key or frozen token env", () => {
    const credentials = profile();
    const pod = desiredResources(
      workspace(),
      project(),
      {
        workspaceImage: "fixture:1",
        backendSecret: "backend",
        storageSize: "5Gi",
        imagePullPolicy: "Never",
      },
      credentials,
    ).pod;
    expect(JSON.stringify(pod)).not.toContain("app-private");
    for (const container of [
      ...(pod.spec?.initContainers ?? []),
      ...(pod.spec?.containers ?? []),
    ]) {
      expect(
        container.env?.some((env) =>
          ["PASEO_GIT_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN"].includes(env.name),
        ),
      ).toBe(false);
      const mount = container.volumeMounts?.find((mount) => mount.name === "git-token");
      expect(mount?.subPath).toBeUndefined();
      expect(mount?.readOnly).toBe(true);
    }
    const otherProject = project();
    otherProject.spec.repository = "https://github.com/other/repo.git";
    expect(() =>
      desiredResources(
        workspace(),
        otherProject,
        {
          workspaceImage: "fixture:1",
          backendSecret: "backend",
          storageSize: "5Gi",
          imagePullPolicy: "Never",
        },
        credentials,
      ),
    ).toThrow("allowlist");
  });
  it("rejects shared Codex refresh files and conflicting Git authority", () => {
    const credentials = profile();
    expect(() =>
      CredentialProfileSchema.parse({
        ...credentials,
        spec: {
          ...credentials.spec,
          files: [
            {
              path: ".codex/auth.json",
              valueFrom: { secretKeyRef: { name: "shared-login", key: "auth.json" } },
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      CredentialProfileSchema.parse({
        ...credentials,
        spec: {
          ...credentials.spec,
          git: { ...credentials.spec.git, tokenSecretRef: { name: "static", key: "token" } },
        },
      }),
    ).toThrow();
  });
});

describe("live projected access-token consumption", () => {
  it("Git and gh reopen the current Kubernetes-style symlink after token rotation", () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-rotation-"));
    try {
      for (const [version, token] of [
        ["version1", "first-token"],
        ["version2", "second-token"],
      ]) {
        if (!version || !token) throw new Error("Missing fixture");
        mkdirSync(join(root, version));
        writeFileSync(join(root, version, "token"), token);
      }
      symlinkSync("version1", join(root, "..data"));
      symlinkSync("..data/token", join(root, "token"));
      const env = {
        PATH: process.env.PATH,
        PASEO_GIT_TOKEN_FILE: join(root, "token"),
        PASEO_GIT_HOST: "github.com",
        PASEO_GIT_PATH: "org/repo.git",
        GH_HOST: "github.com",
      };
      function git() {
        return spawnSync(process.execPath, [resolve("docker/git-credential.mjs"), "get"], {
          env,
          encoding: "utf8",
          input: "protocol=https\nhost=github.com\npath=org/repo.git\n\n",
        }).stdout;
      }
      function gh() {
        const script = `import {githubEnvironment} from ${JSON.stringify(pathToFileURL(resolve("docker/token-file.mjs")).href)}; process.stdout.write(githubEnvironment().GH_TOKEN);`;
        return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
          env,
          encoding: "utf8",
        }).stdout;
      }
      expect(git()).toContain("password=first-token");
      expect(gh()).toBe("first-token");
      symlinkSync("version2", join(root, "..next"));
      renameSync(join(root, "..next"), join(root, "..data"));
      expect(git()).toContain("password=second-token");
      expect(gh()).toBe("second-token");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
