import type { V1Pod, V1Service } from "@kubernetes/client-node";
import { desiredResources, type RuntimeConfig } from "../controller/resources.js";
import {
  API_GROUP,
  API_VERSION,
  type CredentialProfile,
  type Project,
  type Workspace,
} from "../domain.js";
import type { Infrastructure } from "../kubernetes/store.js";

const PROBE_LABEL = `${API_GROUP}/provider-probe`;
const RUN_LABEL = `${API_GROUP}/provider-probe-run`;

/** A real project-owned, disposable checkout. It is never a user Workspace CR. */
export function providerProbeResources(input: {
  project: Project;
  profile: CredentialProfile;
  runId: string;
  config: RuntimeConfig;
}): { pod: V1Pod; service: V1Service; name: string } {
  const { project, profile, runId, config } = input;
  if (!project.metadata.uid)
    throw new Error("Project UID is required for provider probe ownership");
  if (profile.metadata.name !== project.spec.credentialProfile)
    throw new Error("Provider probe credential profile mismatch");
  if (profile.metadata.namespace !== project.metadata.namespace)
    throw new Error("Provider probe namespace mismatch");
  const probeWorkspace: Workspace = {
    apiVersion: API_VERSION,
    kind: "PaseoWorkspace",
    metadata: {
      name: `catalog-${runId.replace(/-/g, "").slice(0, 24)}`,
      namespace: project.metadata.namespace,
      uid: runId,
    },
    spec: {
      projectRef: project.metadata.name,
      credentialProfile: project.spec.credentialProfile,
      displayName: "Provider catalog probe",
      residency: "Running",
      revision: project.spec.revision,
      retentionPolicy: { storage: "Ephemeral" },
    },
  };
  // Discovery never inherits unbounded operator resource overrides. It uses
  // the same image, provider files/env, repository and revision, within a
  // fixed diagnostic resource budget.
  const boundedProject: Project = {
    ...project,
    spec: {
      ...project.spec,
      runtime: project.spec.runtime?.image ? { image: project.spec.runtime.image } : undefined,
      cache: undefined,
    },
  };
  const boundedProfile: CredentialProfile = {
    ...profile,
    spec: {
      ...profile.spec,
      runtime: profile.spec.runtime?.image ? { image: profile.spec.runtime.image } : undefined,
      git: profile.spec.git ? { ...profile.spec.git, signing: undefined } : undefined,
    },
  };
  const { pod, service } = desiredResources(
    probeWorkspace,
    boundedProject,
    {
      ...config,
      gatewayUrl: undefined,
      referenceCacheAvailable: false,
      storageSize: "1Gi",
    },
    boundedProfile,
  );
  const ownerReferences = [
    {
      apiVersion: API_VERSION,
      kind: "PaseoProject",
      name: project.metadata.name,
      uid: project.metadata.uid,
      controller: true,
      blockOwnerDeletion: false,
    },
  ];
  const labels = { ...pod.metadata?.labels, [PROBE_LABEL]: "true", [RUN_LABEL]: runId };
  pod.metadata = { ...pod.metadata, labels, ownerReferences };
  service.metadata = { ...service.metadata, labels, ownerReferences };
  if (!pod.spec || !service.spec) throw new Error("Provider probe resources are incomplete");
  pod.spec.activeDeadlineSeconds = 300;
  pod.spec.terminationGracePeriodSeconds = 5;
  pod.spec.automountServiceAccountToken = false;
  service.spec.selector = labels;
  const daemon = pod.spec.containers.find((container) => container.name === "daemon");
  if (!daemon) throw new Error("Provider probe daemon is required");
  // Git credentials are needed for the disposable checkout, not for model
  // discovery after it. Provider env/files and access-only broker output remain.
  daemon.volumeMounts = daemon.volumeMounts?.filter(
    (mount) => !["git-token", "git-ssh", "git-signing"].includes(mount.name),
  );
  daemon.env = daemon.env?.filter(
    (env) =>
      ![
        "PASEO_GIT_TOKEN_FILE",
        "PASEO_GIT_HOST",
        "PASEO_GIT_PATH",
        "PASEO_GIT_USERNAME",
        "GH_HOST",
        "GIT_SSH_COMMAND",
      ].includes(env.name) && !env.name.startsWith("GIT_CONFIG_"),
  );
  // The pinned Codex access-only launcher lives here; discovery may use the
  // projected broker output but must never read or renew the authority token.
  daemon.env?.push({ name: "PATH", value: "/opt/paseo/bin:/usr/local/bin:/usr/bin:/bin" });
  // No signing/private-key projection should remain in any probe container.
  pod.spec.volumes = pod.spec.volumes?.filter((volume) => volume.name !== "git-signing");
  const name = pod.metadata?.name;
  if (!name) throw new Error("Provider probe resource name is unavailable");
  return { pod, service, name };
}

export function isOwnedProviderProbe(input: {
  object: Infrastructure | undefined;
  name: string;
  projectUid: string;
  runId?: string;
  resourceUid?: string;
}): boolean {
  const { object, name, projectUid, runId, resourceUid } = input;
  return (
    !!object?.metadata?.uid &&
    object.metadata.name === name &&
    object.metadata.labels?.[PROBE_LABEL] === "true" &&
    (!runId || object.metadata.labels?.[RUN_LABEL] === runId) &&
    (!resourceUid || object.metadata.uid === resourceUid) &&
    object.metadata.ownerReferences?.some(
      (owner) => owner.kind === "PaseoProject" && owner.uid === projectUid,
    ) === true
  );
}
