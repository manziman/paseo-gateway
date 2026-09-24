import type { V1Secret } from "@kubernetes/client-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desiredResources, resourceName } from "../src/controller/resources.js";
import { type AccessSecretStore, WorkspaceAccess } from "../src/controller/workspace-access.js";
import { WORKSPACE_UID_LABEL } from "../src/domain.js";
import { issueWorkspaceToken, verifyWorkspaceToken } from "../src/gateway/auth.js";
import { project, workspace } from "./fixtures.js";

const auth = { signingKey: "dedicated-signing-key-0123456789abcdef", audience: "gateway-id" };
class Secrets implements AccessSecretStore {
  row?: V1Secret;
  writes = 0;
  conflict = false;
  async readSecret() {
    return structuredClone(this.row);
  }
  async compareAndSwapSecret(_name: string, version: string | undefined, secret: V1Secret) {
    if (this.conflict || version !== this.row?.metadata?.resourceVersion) return false;
    this.row = {
      ...structuredClone(secret),
      metadata: { ...secret.metadata, resourceVersion: String(++this.writes) },
    };
    return true;
  }
  token() {
    return Buffer.from(this.row?.data?.token ?? "", "base64").toString("utf8");
  }
}
afterEach(() => vi.useRealTimers());
describe("projected workspace access", () => {
  it("projects only a scoped token and reuses an unexpired exact grant", async () => {
    const store = new Secrets();
    const access = new WorkspaceAccess(store, auth);
    const row = workspace();
    await access.ensure(row);
    await access.ensure(row);
    expect(store.writes).toBe(1);
    expect(verifyWorkspaceToken(store.token(), auth)).toMatchObject({
      kind: "workspace",
      projectIds: ["example"],
      credentialProfiles: ["claude-default"],
      originWorkspaceUid: "uid-one",
    });
    expect(Object.keys(store.row?.data ?? {})).toEqual(["token"]);
    expect(JSON.stringify(store.row)).not.toContain(auth.signingKey);
    expect(store.row?.metadata?.ownerReferences).toContainEqual(
      expect.objectContaining({ kind: "PaseoWorkspace", uid: "uid-one" }),
    );
  });
  it("renews projected content before expiry and after signing-key rotation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T00:00:00Z"));
    const store = new Secrets();
    const row = workspace();
    const access = new WorkspaceAccess(store, auth);
    await access.ensure(row);
    const original = store.token();
    vi.setSystemTime(new Date("2026-09-24T23:31:00Z"));
    await access.ensure(row);
    expect(store.writes).toBe(2);
    expect(store.token()).not.toBe(original);
    const rotated = { ...auth, signingKey: "replacement-signing-key-0123456789abcdef" };
    await new WorkspaceAccess(store, rotated).ensure(row);
    expect(store.writes).toBe(3);
    expect(verifyWorkspaceToken(store.token(), rotated)).toBeDefined();
    expect(verifyWorkspaceToken(store.token(), auth)).toBeUndefined();
  });
  it("renews changed project/profile bindings and removes an over-broad existing grant", async () => {
    const store = new Secrets();
    const row = workspace();
    const access = new WorkspaceAccess(store, auth);
    await access.ensure(row);
    row.spec.credentialProfile = "other-role";
    await access.ensure(row);
    expect(verifyWorkspaceToken(store.token(), auth)?.credentialProfiles).toEqual(["other-role"]);
    row.spec.projectRef = "other-project";
    await access.ensure(row);
    expect(verifyWorkspaceToken(store.token(), auth)?.projectIds).toEqual(["other-project"]);
    if (!store.row?.data) throw new Error("No secret");
    store.row.data.token = Buffer.from(
      issueWorkspaceToken(auth, {
        projectIds: ["other-project", "extra"],
        credentialProfiles: ["other-role"],
        originWorkspaceId: row.metadata.name,
        originWorkspaceUid: row.metadata.uid ?? "",
        ttlSeconds: 86400,
      }),
    ).toString("base64");
    await access.ensure(row);
    expect(verifyWorkspaceToken(store.token(), auth)?.projectIds).toEqual(["other-project"]);
  });
  it("refuses foreign ownership, missing UID and lost compare-and-swap", async () => {
    const store = new Secrets();
    const access = new WorkspaceAccess(store, auth);
    const row = workspace();
    store.row = { metadata: { labels: { [WORKSPACE_UID_LABEL]: "foreign" } } };
    await expect(access.ensure(row)).rejects.toThrow("unowned");
    expect(store.writes).toBe(0);
    store.row = undefined;
    store.conflict = true;
    await expect(access.ensure(row)).rejects.toThrow("concurrently");
    delete row.metadata.uid;
    await expect(access.ensure(row)).rejects.toThrow("UID");
  });
  it("mounts renewable token as a whole read-only Secret volume without owner/signing keys", () => {
    const row = workspace();
    const resources = desiredResources(row, project(), {
      workspaceImage: "test",
      storageSize: "1Gi",
      backendSecret: "backend",
      imagePullPolicy: "Never",
      gatewayUrl: "ws://gateway.test.svc/ws",
    });
    const daemon = resources.pod.spec?.containers[0];
    expect(daemon?.volumeMounts).toContainEqual({
      name: "gateway-access",
      mountPath: "/run/paseo-gateway",
      readOnly: true,
    });
    expect(resources.pod.spec?.volumes).toContainEqual({
      name: "gateway-access",
      secret: { secretName: `${resourceName(row)}-access`, defaultMode: 0o440 },
    });
    expect(resources.pod.spec?.automountServiceAccountToken).toBe(false);
    expect(JSON.stringify(resources)).not.toContain(auth.signingKey);
    expect(daemon?.env).toContainEqual({
      name: "PASEO_GATEWAY_TOKEN_FILE",
      value: "/run/paseo-gateway/token",
    });
  });
});
