import type { V1Secret } from "@kubernetes/client-node";
import { API_VERSION, WORKSPACE_UID_LABEL, type Workspace } from "../domain.js";
import {
  issueWorkspaceToken,
  type ScopedAuthOptions,
  verifyWorkspaceToken,
} from "../gateway/auth.js";
import { resourceName } from "./resources.js";

export interface AccessSecretStore {
  readSecret(name: string): Promise<V1Secret | undefined>;
  compareAndSwapSecret(
    name: string,
    version: string | undefined,
    secret: V1Secret,
  ): Promise<boolean>;
}

/** Scoped tokens renew in a projected volume; the owner password never enters worker pods. */
export class WorkspaceAccess {
  constructor(
    private readonly store: AccessSecretStore,
    private readonly auth: ScopedAuthOptions,
  ) {}
  async ensure(workspace: Workspace) {
    if (!workspace.metadata.uid) throw new Error("Workspace UID required for access grant");
    const name = `${resourceName(workspace)}-access`;
    const existing = await this.store.readSecret(name);
    if (existing && existing.metadata?.labels?.[WORKSPACE_UID_LABEL] !== workspace.metadata.uid)
      throw new Error("Refusing to replace an unowned workspace access Secret");
    const token = existing?.data?.token
      ? Buffer.from(existing.data.token, "base64").toString("utf8")
      : "";
    const grant = verifyWorkspaceToken(token, this.auth);
    if (
      grant &&
      grant.expiresAt > Date.now() / 1000 + 1800 &&
      grant.originWorkspaceUid === workspace.metadata.uid &&
      grant.originWorkspaceId === workspace.metadata.name &&
      grant.projectIds.length === 1 &&
      grant.projectIds[0] === workspace.spec.projectRef &&
      grant.credentialProfiles.length === 1 &&
      grant.credentialProfiles[0] === workspace.spec.credentialProfile
    )
      return;
    const next = issueWorkspaceToken(this.auth, {
      projectIds: [workspace.spec.projectRef],
      credentialProfiles: [workspace.spec.credentialProfile],
      originWorkspaceId: workspace.metadata.name,
      originWorkspaceUid: workspace.metadata.uid,
      ttlSeconds: 86400,
    });
    const written = await this.store.compareAndSwapSecret(
      name,
      existing?.metadata?.resourceVersion,
      {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: {
          name,
          namespace: workspace.metadata.namespace,
          labels: { [WORKSPACE_UID_LABEL]: workspace.metadata.uid },
          ownerReferences: [
            {
              apiVersion: API_VERSION,
              kind: "PaseoWorkspace",
              name: workspace.metadata.name,
              uid: workspace.metadata.uid,
            },
          ],
        },
        data: { token: Buffer.from(next).toString("base64") },
      },
    );
    if (!written)
      throw new Error("Workspace access grant changed concurrently; retry reconciliation");
  }
}
