import type {
  V1ConfigMap,
  V1PersistentVolumeClaim,
  V1Pod,
  V1Secret,
  V1Service,
} from "@kubernetes/client-node";
import type { CredentialProfile, Project, Workspace, WorkspaceStatus } from "../domain.js";

export type Infrastructure = V1Pod | V1Service | V1PersistentVolumeClaim;
export type InfrastructureKind = "Pod" | "Service" | "PersistentVolumeClaim";

/** The controller and gateway share Kubernetes records, not process-local ownership. */
export interface Store {
  projects(): Promise<Project[]>;
  workspaces(): Promise<Workspace[]>;
  createWorkspace(workspace: Workspace): Promise<Workspace>;
  setResidency(workspace: Workspace, residency: Workspace["spec"]["residency"]): Promise<void>;
  status(workspace: Workspace, status: WorkspaceStatus): Promise<void>;
  get(kind: InfrastructureKind, name: string): Promise<Infrastructure | undefined>;
  create(object: Infrastructure): Promise<Infrastructure>;
  deletePod(name: string, uid: string): Promise<void>;
  deleteService(name: string, uid: string): Promise<void>;
  secret(name: string): Promise<V1Secret>;
  credentialProfile(name: string): Promise<CredentialProfile | undefined>;
  configMap(name: string): Promise<V1ConfigMap>;
  teardown(workspace: Workspace): Promise<void>;
  deleteStorage(name: string, uid: string): Promise<void>;
  /** Remove owned terminal workspace Service/access Secret; true only after both are absent. */
  deleteRuntime(workspace: Workspace): Promise<boolean>;
}

export function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "number") return error.code;
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
  return undefined;
}
