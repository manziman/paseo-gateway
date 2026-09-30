import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import type { V1Secret } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import {
  codexAccess,
  type NativeCodexResult,
  refreshWithNativeCodex,
} from "../src/credentials/codex-native.js";
import { CodexSubscriptionBroker } from "../src/credentials/codex-subscription.js";
import type { BrokerSecretStore } from "../src/credentials/github-app.js";
import { credentialProjection, referencedCredentials } from "../src/credentials/projection.js";
import { API_VERSION, CredentialProfileSchema } from "../src/domain.js";
import { project, workspace } from "./fixtures.js";

const profile = () =>
  CredentialProfileSchema.parse({
    apiVersion: API_VERSION,
    kind: "PaseoCredentialProfile",
    metadata: { name: "claude-default", namespace: "test", uid: "profile-1" },
    spec: {
      codexSubscription: {
        authSecretRef: { name: "authority", key: "auth.json" },
        outputSecretName: "worker-access",
      },
    },
  });
const fixtureAuth = (n: number) =>
  JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: `private-refresh-${n}` } });
class Secrets implements BrokerSecretStore {
  version = 1;
  objects = new Map<string, V1Secret>([
    [
      "authority",
      {
        metadata: { name: "authority", uid: "auth-1", resourceVersion: "1" },
        data: { "auth.json": Buffer.from(fixtureAuth(1)).toString("base64") },
      },
    ],
  ]);
  async readSecret(name: string) {
    const value = this.objects.get(name);
    return value ? structuredClone(value) : undefined;
  }
  async compareAndSwapSecret(name: string, version: string | undefined, secret: V1Secret) {
    if (this.objects.get(name)?.metadata?.resourceVersion !== version) return false;
    this.objects.set(name, {
      ...structuredClone(secret),
      metadata: { ...secret.metadata, resourceVersion: String(++this.version) },
    });
    return true;
  }
}
function result(now: number): NativeCodexResult {
  return {
    authJson: fixtureAuth(2),
    access: {
      accessToken: "worker-access-only",
      chatgptAccountId: "fixture-account",
      chatgptPlanType: "pro",
      expiresAt: new Date(now + 3600000).toISOString(),
    },
  };
}

describe("Codex subscription authority", () => {
  it("serializes concurrent workers, commits native state before access publication, and reuses durable access after restart", async () => {
    const store = new Secrets();
    const now = Date.now();
    const native = vi.fn(async () => result(now));
    const a = new CodexSubscriptionBroker(store, { native, now: () => now });
    const b = new CodexSubscriptionBroker(store, { native, now: () => now });
    await Promise.all([a.reconcile([profile()]), b.reconcile([profile()])]);
    expect(native).toHaveBeenCalledTimes(1);
    const output = JSON.stringify(store.objects.get("worker-access"));
    expect(output).not.toContain("private-refresh");
    const payload = Buffer.from(
      store.objects.get("worker-access")?.data?.["access.json"] ?? "",
      "base64",
    ).toString();
    expect(payload).toContain("worker-access-only");
    expect(payload).not.toContain("refresh");
    expect(
      Buffer.from(store.objects.get("authority")?.data?.["auth.json"] ?? "", "base64").toString(),
    ).toBe(fixtureAuth(2));
    expect(await b.reconcile([profile()])).toEqual([expect.objectContaining({ state: "Ready" })]);
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("fences an uncertain native failure across lease expiry; only a fresh bootstrap recovers", async () => {
    const store = new Secrets();
    let now = Date.now();
    const native = vi.fn(async () => {
      throw new Error("private-refresh-secret");
    });
    const broker = new CodexSubscriptionBroker(store, { native, now: () => now });
    const failed = await broker.reconcile([profile()]);
    expect(JSON.stringify(failed)).not.toContain("private-refresh-secret");
    expect(failed[0]?.reason).toBe("CodexReauthenticationRequired");
    now += 61000;
    expect((await broker.reconcile([profile()]))[0]?.reason).toBe("CodexReauthenticationRequired");
    expect(native).toHaveBeenCalledTimes(1);
    const original = await store.readSecret("authority");
    if (!original) throw new Error();
    await store.compareAndSwapSecret("authority", original.metadata?.resourceVersion, {
      ...original,
      data: { "auth.json": Buffer.from(fixtureAuth(3)).toString("base64") },
    });
    expect(
      (
        await new CodexSubscriptionBroker(store, {
          native: async () => result(now),
          now: () => now,
        }).reconcile([profile()])
      )[0]?.state,
    ).toBe("Renewed");
  });
  it("does not treat auth file reformatting as a new refresh credential", async () => {
    const store = new Secrets();
    let now = Date.now();
    const native = vi.fn(async () => {
      throw new Error("refresh response was lost");
    });
    const broker = new CodexSubscriptionBroker(store, { native, now: () => now });
    await broker.reconcile([profile()]);
    now += 61000;
    const source = await store.readSecret("authority");
    if (!source) throw new Error();
    const reformatted = JSON.stringify(JSON.parse(fixtureAuth(1)), null, 2);
    await store.compareAndSwapSecret("authority", source.metadata?.resourceVersion, {
      ...source,
      data: { "auth.json": Buffer.from(reformatted).toString("base64") },
    });
    expect((await broker.reconcile([profile()]))[0]?.reason).toBe("CodexReauthenticationRequired");
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("invalidates old identity access when a replacement bootstrap fails", async () => {
    const store = new Secrets();
    const now = Date.now();
    await new CodexSubscriptionBroker(store, { native: async () => result(now) }).reconcile([
      profile(),
    ]);
    const source = await store.readSecret("authority");
    if (!source) throw new Error();
    await store.compareAndSwapSecret("authority", source.metadata?.resourceVersion, {
      ...source,
      data: { ...source.data, "auth.json": Buffer.from(fixtureAuth(3)).toString("base64") },
    });
    const failed = await new CodexSubscriptionBroker(store, {
      native: async () => {
        throw new Error();
      },
    }).reconcile([profile()]);
    expect(failed[0]?.reason).toBe("CodexReauthenticationRequired");
    expect(store.objects.get("worker-access")?.data?.["access.json"]).toBe("");
  });
  it("rejects authority projection through known hosts and broker state-key collisions", () => {
    const selected = profile();
    selected.spec.git = {
      username: "git",
      ssh: {
        keySecretRef: { name: "ssh", key: "key" },
        knownHostsRef: { secretKeyRef: { name: "authority", key: "auth.json" } },
      },
    };
    expect(() => CredentialProfileSchema.parse(selected)).toThrow();
    const collision = profile();
    if (!collision.spec.codexSubscription) throw new Error();
    collision.spec.codexSubscription.authSecretRef.key = "paseo-access.json";
    expect(() => CredentialProfileSchema.parse(collision)).toThrow();
  });
  it("rejects stale native completion after lease expiry without publishing access", async () => {
    const store = new Secrets();
    let now = Date.now();
    const broker = new CodexSubscriptionBroker(store, {
      now: () => now,
      native: async () => {
        now += 61000;
        return result(now);
      },
    });
    expect((await broker.reconcile([profile()]))[0]?.reason).toBe("CodexRefreshCommitUncertain");
    expect(store.objects.has("worker-access")).toBe(false);
  });
  it("does not overwrite operator bootstrap replacement or another authority's output", async () => {
    const store = new Secrets();
    const now = Date.now();
    const native = async () => {
      const current = await store.readSecret("authority");
      if (!current) throw new Error();
      await store.compareAndSwapSecret("authority", current.metadata?.resourceVersion, {
        ...current,
        data: { "auth.json": Buffer.from(fixtureAuth(9)).toString("base64") },
      });
      return result(now);
    };
    expect(
      (await new CodexSubscriptionBroker(store, { native }).reconcile([profile()]))[0]?.reason,
    ).toBe("CodexRefreshCommitUncertain");
    expect(store.objects.has("worker-access")).toBe(false);
    store.objects.set("worker-access", {
      metadata: { resourceVersion: "99" },
      data: { protected: "value" },
    });
    expect(
      (await new CodexSubscriptionBroker(store, { native }).reconcile([profile()]))[0]?.reason,
    ).toBe("CodexOutputAlreadyOwned");
    expect(store.objects.get("worker-access")?.data).toEqual({ protected: "value" });
  });
  it("fences a committed state write conflict and never retries its refresh token", async () => {
    const store = new Secrets();
    let now = Date.now();
    const native = vi.fn(async () => {
      const current = store.objects.get("authority");
      if (current?.metadata) current.metadata.resourceVersion = "new-version";
      return result(now);
    });
    const swap = store.compareAndSwapSecret.bind(store);
    store.compareAndSwapSecret = async (name, version, value) =>
      name === "authority" && value.data?.["paseo-access.json"]
        ? false
        : swap(name, version, value);
    const broker = new CodexSubscriptionBroker(store, { native, now: () => now });
    expect((await broker.reconcile([profile()]))[0]?.reason).toBe("CodexRefreshCommitUncertain");
    now += 61000;
    expect((await broker.reconcile([profile()]))[0]?.reason).toBe("CodexReauthenticationRequired");
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("projects only a whole access Secret volume, never the authority Secret", () => {
    const selected = profile();
    const projection = credentialProjection(workspace(), project(), selected);
    expect(referencedCredentials(selected)).toEqual([
      { kind: "Secret", name: "worker-access", key: "access.json" },
    ]);
    expect(JSON.stringify(projection)).not.toContain('"authority"');
    expect(projection.daemonMounts.find((mount) => mount.name === "codex-access")).toEqual({
      name: "codex-access",
      mountPath: "/run/paseo-codex",
      readOnly: true,
    });
    selected.spec.files.push({
      path: ".config/leak",
      valueFrom: { secretKeyRef: { name: "authority", key: "auth.json" } },
      mode: 0o440,
    });
    expect(() => CredentialProfileSchema.parse(selected)).toThrow();
  });
  it("validates native token expiry and rejects unsafe shared auth projection", () => {
    const now = Date.now();
    const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.signature`;
    expect(codexAccess(token, now).chatgptAccountId).toBe("fixture");
    expect(() => codexAccess(token, now + 3600000)).toThrow("CodexAccessExportInvalidOrExpired");
    expect(() => codexAccess("secret-not-jwt", now)).toThrow("CodexAccessExportInvalidOrExpired");
  });
});

describe("native Codex refresh adapter", () => {
  it("uses the native export RPC and persists its rotated file before removing private temporary state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-native-fixture-"));
    const executable = join(directory, "codex");
    const observed = join(directory, "home-observed");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
fs.writeFileSync(${JSON.stringify(observed)},process.env.CODEX_HOME);let warmed=false;
rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
if(m.method==='getAuthStatus'){if(!m.params.refreshToken){warmed=true;process.stdout.write(JSON.stringify({id:m.id,result:{authMethod:'chatgpt',authToken:null}})+'\\n');return;}if(!warmed||!m.params.includeToken)process.exit(1);
const token='header.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account'}})).toString('base64url')+'.sig';
fs.writeFileSync(process.env.CODEX_HOME+'/auth.json',JSON.stringify({auth_mode:'chatgpt',tokens:{refresh_token:'rotated-native-refresh',access_token:token}}));
process.stdout.write(JSON.stringify({id:m.id,result:{authMethod:'chatgpt',authToken:token}})+'\\n');}});
`,
      { mode: 0o700 },
    );
    try {
      const refreshed = await refreshWithNativeCodex(fixtureAuth(1), { executable });
      expect(refreshed.access.chatgptAccountId).toBe("fixture-account");
      expect(JSON.parse(refreshed.authJson).tokens.refresh_token).toBe("rotated-native-refresh");
      await expect(stat(await readFile(observed, "utf8"))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("bounds executable startup failure and never returns raw native error or credential details", async () => {
    await expect(
      refreshWithNativeCodex(fixtureAuth(1), {
        executable: "/no-such-codex-executable",
        timeoutMs: 100,
      }),
    ).rejects.toThrow("CodexNativeAuthorityFailed");
  });
});

describe("Codex worker protocol bridge", () => {
  it("injects external login before exposing initialization and reads replacement tokens without forwarding refresh to Paseo", async () => {
    const { bridgeCodex } = await import(pathToFileURL(resolve("docker/codex.mjs")).href);
    const dir = await mkdtemp(join(tmpdir(), "paseo-codex-bridge-test-"));
    const path = join(dir, "access.json");
    const input = new PassThrough();
    const output = new PassThrough();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let toChild = "";
    let toClient = "";
    stdin.on("data", (chunk) => {
      toChild += chunk;
    });
    output.on("data", (chunk) => {
      toClient += chunk;
    });
    const access = result(Date.now()).access;
    await writeFile(path, JSON.stringify(access));
    const stop = bridgeCodex({
      input,
      output,
      child: { stdin, stdout, kill() {} },
      accessFile: path,
      timeoutMs: 500,
    });
    try {
      input.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
      stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "fixture" } })}\n`);
      await vi.waitFor(() => expect(toChild).toContain("chatgptAuthTokens"));
      expect(toClient).toBe("");
      const login = toChild
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((entry) => entry.method === "account/login/start");
      expect(login.id).not.toBe("paseo-auth-1");
      input.write(
        `${JSON.stringify({ id: "paseo-auth-1", method: "thread/start", params: {} })}\n`,
      );
      expect(toChild).not.toContain('"method":"thread/start"');
      stdout.write(`${JSON.stringify({ id: login.id, result: { type: "chatgptAuthTokens" } })}\n`);
      await vi.waitFor(() => expect(toChild).toContain('"method":"thread/start"'));
      await vi.waitFor(() => expect(toClient).toContain('"id":1'));
      await writeFile(path, JSON.stringify({ ...access, accessToken: "replacement-access" }));
      stdout.write(
        `${JSON.stringify({ id: 92, method: "account/chatgptAuthTokens/refresh", params: { previousAccountId: access.chatgptAccountId } })}\n`,
      );
      await vi.waitFor(() => expect(toChild).toContain("replacement-access"));
      expect(toClient).not.toContain("replacement-access");
      expect(toClient).not.toContain("refresh");
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects auth files and expired access without disclosing their content", async () => {
    const { readCodexAccess } = await import(pathToFileURL(resolve("docker/codex.mjs")).href);
    const dir = await mkdtemp(join(tmpdir(), "paseo-codex-access-test-"));
    const path = join(dir, "access.json");
    try {
      await writeFile(path, fixtureAuth(1));
      await expect(readCodexAccess(path)).rejects.toThrow("Codex access unavailable");
      await writeFile(path, JSON.stringify(result(0).access));
      await expect(readCodexAccess(path)).rejects.toThrow("Codex access unavailable");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
