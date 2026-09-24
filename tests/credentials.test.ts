import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceController } from "../src/controller/controller.js";
import { desiredResources } from "../src/controller/resources.js";
import { referencedCredentials } from "../src/credentials/projection.js";
import { API_VERSION, CredentialProfileSchema, ProjectSchema } from "../src/domain.js";
import { MemoryStore, project, workspace } from "./fixtures.js";

const config = {
  workspaceImage: "default:1",
  storageSize: "5Gi",
  backendSecret: "backend",
  imagePullPolicy: "Never" as const,
};
function profile(spec: unknown = {}) {
  return CredentialProfileSchema.parse({
    apiVersion: API_VERSION,
    kind: "PaseoCredentialProfile",
    metadata: { name: "claude-default", namespace: "test" },
    spec,
  });
}
const secret = { secretKeyRef: { name: "providers", key: "token" } };
const configMap = { configMapKeyRef: { name: "provider-config", key: "config" } };

describe("credential profile boundaries", () => {
  it.each([
    "HOME",
    "PATH",
    "PASEO_PASSWORD",
    "GIT_CONFIG_COUNT",
    "PASEO_LISTEN",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "REPOSITORY",
    "FETCH_DEPTH",
  ])("protects %s", (name) => {
    expect(() => profile({ env: [{ name, valueFrom: secret }] })).toThrow();
  });
  it.each([
    "/etc/passwd",
    "../escape",
    "a/../../escape",
    "a//b",
    ".paseo/config.json",
    ".gitconfig",
    ".profile",
    "a/./b",
  ])("rejects unsafe path %s", (path) => {
    expect(() => profile({ files: [{ path, valueFrom: secret }] })).toThrow();
  });
  it("rejects inline credentials, ambiguous refs, duplicate env and overlapping files", () => {
    expect(() => profile({ env: [{ name: "OPENAI_API_KEY", value: "secret" }] })).toThrow();
    expect(() =>
      profile({ env: [{ name: "OPENAI_API_KEY", valueFrom: { ...secret, ...configMap } }] }),
    ).toThrow();
    expect(() => profile({ env: [{ name: "OPENAI_API_KEY", valueFrom: {} }] })).toThrow();
    expect(() =>
      profile({
        env: Array.from({ length: 2 }, () => ({ name: "OPENAI_API_KEY", valueFrom: secret })),
      }),
    ).toThrow();
    expect(() =>
      profile({
        files: [
          { path: ".config", valueFrom: secret },
          { path: ".config/provider", valueFrom: secret },
        ],
      }),
    ).toThrow();
    expect(() =>
      profile({
        env: Array.from({ length: 65 }, (_, i) => ({ name: `KEY_${i}`, valueFrom: secret })),
      }),
    ).toThrow();
  });
  it.each([
    "https://github.com/org/repo.git",
    "ssh://git@github.com/org/repo.git",
    "git@github.com:org/repo.git",
  ])("accepts repository %s", (repository) => {
    expect(
      ProjectSchema.safeParse({ ...project(), spec: { ...project().spec, repository } }).success,
    ).toBe(true);
  });
  it.each([
    "https://token@github.com/org/repo",
    "ssh://root@github.com/org/repo",
    "file:///tmp/repo",
    "git://github.com/org/repo",
    "https://github.com/org/repo?token=abc",
  ])("rejects repository %s", (repository) => {
    expect(
      ProjectSchema.safeParse({ ...project(), spec: { ...project().spec, repository } }).success,
    ).toBe(false);
  });
  it("projects references into both containers and merges project overrides over profile defaults", () => {
    const credentials = profile({
      env: [{ name: "OPENAI_API_KEY", valueFrom: secret }],
      files: [{ path: ".config/provider/config.json", valueFrom: configMap }],
      git: {
        tokenSecretRef: { name: "git", key: "token" },
        identity: { name: "Example", email: "example@example.com" },
        signing: { keySecretRef: { name: "git", key: "signing" }, format: "ssh" },
      },
      runtime: { image: "profile:1", resources: { requests: { memory: "1Gi", cpu: "500m" } } },
    });
    const repo = project();
    repo.spec.runtime = { image: "project:2", resources: { requests: { memory: "2Gi" } } };
    const pod = desiredResources(workspace(), repo, config, credentials).pod;
    for (const container of [
      ...(pod.spec?.initContainers ?? []),
      ...(pod.spec?.containers ?? []),
    ]) {
      expect(container.image).toBe("project:2");
      expect(container.env).toContainEqual({
        name: "PASEO_GIT_TOKEN_FILE",
        value: "/run/paseo-git/token",
      });
      expect(container.env).toContainEqual({ name: "OPENAI_API_KEY", valueFrom: secret });
      expect(container.env?.some((env) => env.name === "GIT_CONFIG_COUNT")).toBe(true);
      expect(
        container.volumeMounts?.find((mount) => mount.name === "profile-file-0")?.readOnly,
      ).toBe(true);
    }
    expect(pod.spec?.containers[0]?.resources?.requests).toEqual({ memory: "2Gi", cpu: "500m" });
    expect(referencedCredentials(credentials)).toEqual([
      { kind: "Secret", name: "providers", key: "token" },
      { kind: "ConfigMap", name: "provider-config", key: "config" },
      { kind: "Secret", name: "git", key: "token" },
      { kind: "Secret", name: "git", key: "signing" },
    ]);
  });
  it("requires namespace-local profiles and strict host checking for SSH", () => {
    const repo = project();
    repo.spec.repository = "git@github.com:org/repo.git";
    expect(() => desiredResources(workspace(), repo, config)).toThrow("SSH");
    const credentials = profile({
      git: { ssh: { keySecretRef: { name: "deploy-key", key: "id" }, knownHostsRef: configMap } },
    });
    const pod = desiredResources(workspace(), repo, config, credentials).pod;
    for (const container of [
      ...(pod.spec?.initContainers ?? []),
      ...(pod.spec?.containers ?? []),
    ]) {
      expect(container.env?.find((env) => env.name === "GIT_SSH_COMMAND")?.value).toContain(
        "StrictHostKeyChecking=yes",
      );
    }
    credentials.metadata.namespace = "another-namespace";
    expect(() => desiredResources(workspace(), repo, config, credentials)).toThrow("namespace");
  });
  it("mounts a project cache read-only only during initialization and omits a missing claim", () => {
    const repo = project();
    repo.spec.cache = { claimName: "repository-mirror", subPath: "repositories/example.git" };
    const pod = desiredResources(workspace(), repo, config).pod;
    expect(pod.spec?.initContainers?.[0]?.volumeMounts).toContainEqual({
      name: "reference-cache",
      mountPath: "/reference/git",
      subPath: "repositories/example.git",
      readOnly: true,
    });
    expect(
      pod.spec?.containers[0]?.volumeMounts?.some((mount) => mount.name === "reference-cache"),
    ).toBe(false);
    const cold = desiredResources(workspace(), repo, {
      ...config,
      referenceCacheAvailable: false,
    }).pod;
    expect(cold.spec?.volumes?.some((volume) => volume.name === "reference-cache")).toBe(false);
    expect(
      ProjectSchema.safeParse({
        ...repo,
        spec: { ...repo.spec, cache: { claimName: "repository-mirror", subPath: "../outside" } },
      }).success,
    ).toBe(false);
  });
  it("preserves legacy token-only Secret profiles", () => {
    const pod = desiredResources(workspace(), project(), config).pod;
    expect(pod.spec?.containers[0]?.env).toContainEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      valueFrom: { secretKeyRef: { name: "claude-default", key: "token" } },
    });
  });
  it("fails missing profile references before creating resources, without serializing Secret values", async () => {
    const store = new MemoryStore();
    const row = workspace();
    store.workspaceRows = [row];
    store.profileRows.set(
      "claude-default",
      profile({
        env: [{ name: "OPENAI_API_KEY", valueFrom: secret }],
        files: [{ path: ".config/provider", valueFrom: configMap }],
      }),
    );
    store.secretRows.set("providers", {
      data: { token: Buffer.from("sensitive-fixture-value").toString("base64") },
    });
    await new WorkspaceController(store, config).reconcile(row, store.projectRows);
    expect(row.status?.phase).toBe("Failed");
    expect(store.objects.size).toBe(0);
    store.configMapRows.set("provider-config", { data: { config: "{}" } });
    await new WorkspaceController(store, config).reconcile(row, store.projectRows);
    expect(store.objects.size).toBe(3);
    expect(JSON.stringify([...store.objects.values()])).not.toContain("sensitive-fixture-value");
    expect(JSON.stringify([...store.objects.values()])).not.toContain(
      Buffer.from("sensitive-fixture-value").toString("base64"),
    );
  });
});

describe("Git credential helper", () => {
  function helper(input: string, operation = "get", token = "fixture-token") {
    const root = mkdtempSync(join(tmpdir(), "paseo-git-helper-"));
    const path = join(root, "token");
    writeFileSync(path, token);
    const result = spawnSync(process.execPath, [resolve("docker/git-credential.mjs"), operation], {
      input,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        PASEO_GIT_HOST: "github.com",
        PASEO_GIT_PATH: "org/repo.git",
        PASEO_GIT_TOKEN_FILE: path,
      },
    });
    rmSync(root, { recursive: true, force: true });
    return result;
  }
  it("serves only the exact HTTPS repository and does not persist credentials", () => {
    expect(helper("protocol=https\nhost=github.com\npath=org/repo.git\n\n").stdout).toBe(
      "username=x-access-token\npassword=fixture-token\n\n",
    );
    expect(helper("protocol=https\nhost=attacker.example\npath=org/repo.git\n\n").stdout).toBe("");
    expect(helper("protocol=https\nhost=github.com\npath=other/repo.git\n\n").stdout).toBe("");
    expect(helper("protocol=http\nhost=github.com\npath=org/repo.git\n\n").stdout).toBe("");
    expect(helper("password=fixture-token\n\n", "store").stdout).toBe("");
    expect(
      helper(
        "protocol=https\nhost=github.com\npath=org/repo.git\n\n",
        "get",
        "token\npassword=inject",
      ).stdout,
    ).toBe("");
  });
});
