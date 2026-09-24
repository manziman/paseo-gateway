import { randomUUID } from "node:crypto";
import type { V1ConfigMap, V1Secret } from "@kubernetes/client-node";
import {
  API_VERSION,
  type CredentialProfile,
  type Project,
  type Workspace,
  type WorkspaceStatus,
} from "../src/domain.js";
import type { Infrastructure, InfrastructureKind, Store } from "../src/kubernetes/store.js";

export function project(): Project {
  return {
    apiVersion: API_VERSION,
    kind: "PaseoProject",
    metadata: { name: "example", namespace: "test" },
    spec: {
      displayName: "Example",
      repository: "https://github.com/octocat/Hello-World.git",
      revision: "HEAD",
      credentialProfile: "claude-default",
    },
  };
}
export function workspace(name = "one"): Workspace {
  return {
    apiVersion: API_VERSION,
    kind: "PaseoWorkspace",
    metadata: { name, namespace: "test", uid: `uid-${name}`, generation: 1, resourceVersion: "1" },
    spec: {
      projectRef: "example",
      displayName: name,
      revision: "HEAD",
      credentialProfile: "claude-default",
      residency: "Running",
    },
    status: { phase: "Ready", message: "ready", observedGeneration: 1 },
  };
}

/** Stateful fake models Kubernetes create conflicts and ownership, without reproducing the reconciler. */
export class MemoryStore implements Store {
  projectRows = [project()];
  workspaceRows: Workspace[] = [];
  objects = new Map<string, Infrastructure>();
  secretRows = new Map<string, V1Secret>([["claude-default", { data: { token: "dGVzdA==" } }]]);
  profileRows = new Map<string, CredentialProfile>();
  configMapRows = new Map<string, V1ConfigMap>();
  writes = 0;
  deletions: string[] = [];
  async projects() {
    return structuredClone(this.projectRows);
  }
  async workspaces() {
    return structuredClone(this.workspaceRows);
  }
  async createWorkspace(input: Workspace) {
    const row = { ...input, metadata: { ...input.metadata, uid: randomUUID(), generation: 1 } };
    this.workspaceRows.push(row);
    return structuredClone(row);
  }
  async setResidency(input: Workspace, residency: Workspace["spec"]["residency"]) {
    const row = this.workspaceRows.find((w) => w.metadata.name === input.metadata.name);
    if (!row) throw new Error("not found");
    row.spec.residency = residency;
  }
  async status(input: Workspace, status: WorkspaceStatus) {
    this.writes++;
    const row = this.workspaceRows.find((w) => w.metadata.name === input.metadata.name);
    if (row) row.status = structuredClone(status);
  }
  async get(kind: InfrastructureKind, name: string) {
    return this.objects.get(`${kind}/${name}`);
  }
  async create(input: Infrastructure) {
    const key = `${input.kind}/${input.metadata?.name}`;
    if (this.objects.has(key)) throw { code: 409 };
    this.writes++;
    this.objects.set(key, { ...input, metadata: { ...input.metadata, uid: randomUUID() } });
  }
  async deletePod(name: string, uid: string) {
    const key = `Pod/${name}`;
    if (this.objects.get(key)?.metadata?.uid !== uid) throw { code: 409 };
    this.deletions.push(name);
    this.objects.delete(key);
  }
  async secret(name: string) {
    const secret = this.secretRows.get(name);
    if (!secret) throw { code: 404 };
    return secret;
  }
  async credentialProfile(name: string) {
    return structuredClone(this.profileRows.get(name));
  }
  async configMap(name: string) {
    const value = this.configMapRows.get(name);
    if (!value) throw { code: 404 };
    return value;
  }
  async teardown(_workspace: Workspace) {}
  async deleteRuntime(workspace: Workspace) {
    const { resourceName } = await import("../src/controller/resources.js");
    this.objects.delete(`Service/${resourceName(workspace)}`);
    this.secretRows.delete(`${resourceName(workspace)}-access`);
    return true;
  }
  async deleteStorage(name: string, uid: string) {
    const key = `PersistentVolumeClaim/${name}`;
    if (this.objects.get(key)?.metadata?.uid !== uid) throw { code: 409 };
    this.objects.delete(key);
  }
}
