import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { V1PersistentVolumeClaim, V1Pod, V1Service } from "@kubernetes/client-node";
import { credentialProjection } from "../credentials/projection.js";
import {
  API_GROUP,
  API_VERSION,
  type CredentialProfile,
  MANAGED_BY,
  type Project,
  WORKSPACE_UID_LABEL,
  type Workspace,
  workspacePath,
} from "../domain.js";

export interface RuntimeConfig {
  workspaceImage: string;
  referenceCacheAvailable?: boolean;
  storageClass?: string;
  storageAccessMode?: "ReadWriteOnce" | "ReadWriteOncePod";
  tlsSecret?: string;
  storageSize: string;
  backendSecret: string;
  imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  gatewayUrl?: string;
}

export function resourceName(workspace: Workspace): string {
  return `ws-${createHash("sha256")
    .update(workspace.metadata.uid ?? workspace.metadata.name)
    .digest("hex")
    .slice(0, 24)}`;
}

/** Resources are deterministic; PVCs deliberately have no owner reference so deletion retains data. */
export function desiredResources(
  workspace: Workspace,
  project: Project,
  config: RuntimeConfig,
  profile?: CredentialProfile,
) {
  const referenceCache = config.referenceCacheAvailable !== false ? project.spec.cache : undefined;
  const credentials = credentialProjection(workspace, project, profile);
  const image =
    project.spec.runtime?.image ?? profile?.spec.runtime?.image ?? config.workspaceImage;
  const resourceOverrides = {
    requests: {
      ...profile?.spec.runtime?.resources?.requests,
      ...project.spec.runtime?.resources?.requests,
    },
    limits: {
      ...profile?.spec.runtime?.resources?.limits,
      ...project.spec.runtime?.resources?.limits,
    },
  };
  if (!workspace.metadata.uid) throw new Error("Workspace must have a Kubernetes UID");
  const name = resourceName(workspace);
  const labels = {
    "app.kubernetes.io/managed-by": MANAGED_BY,
    "app.kubernetes.io/component": "workspace",
    [WORKSPACE_UID_LABEL]: workspace.metadata.uid,
    "paseo-gateway.manziman.github.io/credential-profile": workspace.spec.credentialProfile,
    [`${API_GROUP}/project`]: workspace.spec.projectRef,
  };
  const metadata = { name, namespace: workspace.metadata.namespace, labels };
  const ownerReferences = [
    {
      apiVersion: API_VERSION,
      kind: "PaseoWorkspace",
      name: workspace.metadata.name,
      uid: workspace.metadata.uid,
      controller: true,
      blockOwnerDeletion: false,
    },
  ];
  const securityContext = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };
  // Kubelet creates subPath mount parents as root while preparing the checkout
  // container. Create the home and profile-file parent directories first in a
  // separate non-root init container that mounts only the data volume.
  const profileHomeDirectories = [
    "/data/home",
    ...new Set((profile?.spec.files ?? []).map((file) => dirname(`/data/home/${file.path}`))),
  ];
  const pvc: V1PersistentVolumeClaim = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata,
    spec: {
      accessModes: [config.storageAccessMode ?? "ReadWriteOnce"],
      resources: { requests: { storage: config.storageSize } },
      ...(config.storageClass ? { storageClassName: config.storageClass } : {}),
    },
  };
  const service: V1Service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { ...metadata, ownerReferences },
    spec: {
      selector: labels,
      ports: [{ name: "daemon", port: 6767, targetPort: config.tlsSecret ? 6768 : 6767 }],
    },
  };
  const pod: V1Pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { ...metadata, ownerReferences },
    spec: {
      automountServiceAccountToken: false,
      serviceAccountName: "paseo-workspace",
      restartPolicy: "Always",
      terminationGracePeriodSeconds: 60,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
        seccompProfile: { type: "RuntimeDefault" },
      },
      initContainers: [
        ...(profile?.spec.files?.length
          ? [
              {
                name: "prepare-home",
                image,
                imagePullPolicy: config.imagePullPolicy,
                command: [
                  "node",
                  "-e",
                  "const {mkdir}=require('node:fs/promises');(async()=>{for(const path of process.argv.slice(1))await mkdir(path,{recursive:true})})().catch(error=>{console.error(error.code??'PrepareHomeFailed');process.exitCode=1})",
                  ...profileHomeDirectories,
                ],
                securityContext,
                resources: {
                  requests: { cpu: "10m", memory: "32Mi" },
                  limits: { cpu: "200m", memory: "128Mi" },
                },
                volumeMounts: [
                  { name: "data", mountPath: "/data" },
                  { name: "tmp", mountPath: "/tmp" },
                ],
              },
            ]
          : []),
        {
          name: "checkout",
          image,
          imagePullPolicy: config.imagePullPolicy,
          command: ["node", "/opt/paseo/initialize.mjs"],
          terminationMessagePath: "/dev/termination-log",
          terminationMessagePolicy: "File",
          env: [
            ...credentials.env,
            { name: "HOME", value: "/data/home" },
            { name: "FETCH_DEPTH", value: String(workspace.spec.fetchDepth ?? 1) },
            { name: "PULL_REQUEST", value: String(workspace.spec.pullRequest ?? "") },
            { name: "REPOSITORY", value: project.spec.repository },
            { name: "REVISION", value: workspace.spec.revision },
            { name: "BRANCH", value: workspace.spec.branch ?? "" },
          ],
          securityContext,
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits: { cpu: "1", memory: "512Mi" },
          },
          volumeMounts: [
            ...credentials.checkoutMounts,
            ...(referenceCache
              ? [
                  {
                    name: "reference-cache",
                    mountPath: "/reference/git",
                    readOnly: true,
                    ...(referenceCache.subPath ? { subPath: referenceCache.subPath } : {}),
                  },
                ]
              : []),
            { name: "data", mountPath: "/data" },
            { name: "tmp", mountPath: "/tmp" },
          ],
        },
      ],
      containers: [
        {
          name: "daemon",
          image,
          imagePullPolicy: config.imagePullPolicy,
          workingDir: workspacePath(workspace.metadata.name),
          securityContext,
          env: [
            ...credentials.env,
            { name: "HOME", value: "/home/paseo" },
            { name: "PASEO_HOME", value: "/home/paseo/.paseo" },
            { name: "PASEO_LISTEN", value: config.tlsSecret ? "127.0.0.1:6767" : "0.0.0.0:6767" },
            {
              name: "PASEO_HOSTNAMES",
              value: `${name},${name}.${workspace.metadata.namespace}.svc`,
            },
            {
              name: "PASEO_PASSWORD",
              valueFrom: { secretKeyRef: { name: config.backendSecret, key: "password" } },
            },
          ],
          ports: [{ name: "daemon", containerPort: 6767 }],
          startupProbe: { tcpSocket: { port: "daemon" }, periodSeconds: 5, failureThreshold: 60 },
          readinessProbe: { tcpSocket: { port: "daemon" }, periodSeconds: 5 },
          livenessProbe: { tcpSocket: { port: "daemon" }, periodSeconds: 20, failureThreshold: 3 },
          resources: {
            requests: { cpu: "250m", memory: "512Mi", ...resourceOverrides.requests },
            limits: { cpu: "2", memory: "2Gi", ...resourceOverrides.limits },
          },
          volumeMounts: [
            ...credentials.daemonMounts,
            { name: "data", mountPath: "/home/paseo", subPath: "home" },
            {
              name: "data",
              mountPath: workspacePath(workspace.metadata.name),
              subPath: "workspace",
            },
            { name: "tmp", mountPath: "/tmp" },
          ],
        },
      ],
      volumes: [
        ...credentials.volumes,
        ...(referenceCache
          ? [
              {
                name: "reference-cache",
                persistentVolumeClaim: { claimName: referenceCache.claimName, readOnly: true },
              },
            ]
          : []),
        workspace.spec.retentionPolicy?.storage === "Ephemeral"
          ? { name: "data", emptyDir: { sizeLimit: config.storageSize } }
          : { name: "data", persistentVolumeClaim: { claimName: name } },
        { name: "tmp", emptyDir: { sizeLimit: "512Mi" } },
      ],
    },
  };
  if (config.tlsSecret && pod.spec) {
    const daemon = pod.spec.containers[0];
    if (!daemon) throw new Error("Workspace daemon container is required");
    // Kubelet TCP probes use the Pod IP; the unencrypted daemon is loopback-only.
    const probe = { exec: { command: ["node", "/opt/paseo/tls-proxy.mjs", "probe"] } };
    daemon.startupProbe = { ...probe, periodSeconds: 5, failureThreshold: 60 };
    daemon.readinessProbe = { ...probe, periodSeconds: 5 };
    daemon.livenessProbe = { ...probe, periodSeconds: 20, failureThreshold: 3 };
    daemon.env?.push({ name: "NODE_EXTRA_CA_CERTS", value: "/run/paseo-tls/ca.crt" });
    daemon.volumeMounts?.push({
      name: "transport-ca",
      mountPath: "/run/paseo-tls",
      readOnly: true,
    });
    pod.spec.containers.push({
      name: "transport",
      image,
      imagePullPolicy: config.imagePullPolicy,
      command: ["node", "/opt/paseo/tls-proxy.mjs"],
      securityContext,
      ports: [{ name: "tls", containerPort: 6768 }],
      resources: {
        requests: { cpu: "10m", memory: "32Mi" },
        limits: { cpu: "200m", memory: "128Mi" },
      },
      readinessProbe: { tcpSocket: { port: "tls" }, periodSeconds: 5 },
      volumeMounts: [{ name: "transport", mountPath: "/run/paseo-tls", readOnly: true }],
    });
    pod.spec.volumes?.push(
      { name: "transport", secret: { secretName: config.tlsSecret, defaultMode: 0o440 } },
      {
        name: "transport-ca",
        secret: {
          secretName: config.tlsSecret,
          defaultMode: 0o440,
          items: [{ key: "ca.crt", path: "ca.crt" }],
        },
      },
    );
  }
  if (config.gatewayUrl && pod.spec) {
    const daemon = pod.spec.containers[0];
    if (daemon) {
      daemon.env?.push(
        { name: "PATH", value: "/opt/paseo/bin:/usr/local/bin:/usr/bin:/bin" },
        { name: "PASEO_GATEWAY_URL", value: config.gatewayUrl },
        { name: "PASEO_GATEWAY_TOKEN_FILE", value: "/run/paseo-gateway/token" },
        { name: "PASEO_CLUSTER_WORKSPACE_ID", value: workspace.metadata.name },
        { name: "PASEO_CLUSTER_PROJECT_ID", value: workspace.spec.projectRef },
      );
      daemon.volumeMounts?.push({
        name: "gateway-access",
        mountPath: "/run/paseo-gateway",
        readOnly: true,
      });
      pod.spec.volumes?.push({
        name: "gateway-access",
        secret: { secretName: `${name}-access`, defaultMode: 0o440 },
      });
    }
  }
  return { pvc, service, pod };
}
