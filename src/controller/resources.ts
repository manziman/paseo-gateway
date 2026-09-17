import { createHash } from "node:crypto";
import type { V1PersistentVolumeClaim, V1Pod, V1Service } from "@kubernetes/client-node";
import {
  API_VERSION,
  MANAGED_BY,
  type Project,
  WORKSPACE_UID_LABEL,
  type Workspace,
  workspacePath,
} from "../domain.js";

export interface RuntimeConfig {
  workspaceImage: string;
  storageClass?: string;
  storageSize: string;
  backendSecret: string;
  imagePullPolicy: "Always" | "IfNotPresent" | "Never";
}

export function resourceName(workspace: Workspace): string {
  return `ws-${createHash("sha256")
    .update(workspace.metadata.uid ?? workspace.metadata.name)
    .digest("hex")
    .slice(0, 24)}`;
}

/** Resources are deterministic; PVCs deliberately have no owner reference so deletion retains data. */
export function desiredResources(workspace: Workspace, project: Project, config: RuntimeConfig) {
  if (!workspace.metadata.uid) throw new Error("Workspace must have a Kubernetes UID");
  const name = resourceName(workspace);
  const labels = {
    "app.kubernetes.io/managed-by": MANAGED_BY,
    "app.kubernetes.io/component": "workspace",
    [WORKSPACE_UID_LABEL]: workspace.metadata.uid,
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
  const pvc: V1PersistentVolumeClaim = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata,
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: config.storageSize } },
      ...(config.storageClass ? { storageClassName: config.storageClass } : {}),
    },
  };
  const service: V1Service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { ...metadata, ownerReferences },
    spec: { selector: labels, ports: [{ name: "daemon", port: 6767, targetPort: 6767 }] },
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
        {
          name: "checkout",
          image: config.workspaceImage,
          imagePullPolicy: config.imagePullPolicy,
          command: ["node", "/opt/paseo/initialize.mjs"],
          env: [
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
            { name: "data", mountPath: "/data" },
            { name: "tmp", mountPath: "/tmp" },
          ],
        },
      ],
      containers: [
        {
          name: "daemon",
          image: config.workspaceImage,
          imagePullPolicy: config.imagePullPolicy,
          workingDir: workspacePath(workspace.metadata.name),
          securityContext,
          env: [
            { name: "HOME", value: "/home/paseo" },
            { name: "PASEO_HOME", value: "/home/paseo/.paseo" },
            { name: "PASEO_LISTEN", value: "0.0.0.0:6767" },
            {
              name: "PASEO_HOSTNAMES",
              value: `${name},${name}.${workspace.metadata.namespace}.svc`,
            },
            {
              name: "PASEO_PASSWORD",
              valueFrom: { secretKeyRef: { name: config.backendSecret, key: "password" } },
            },
            {
              name: "CLAUDE_CODE_OAUTH_TOKEN",
              valueFrom: { secretKeyRef: { name: workspace.spec.credentialProfile, key: "token" } },
            },
          ],
          ports: [{ name: "daemon", containerPort: 6767 }],
          startupProbe: { tcpSocket: { port: "daemon" }, periodSeconds: 5, failureThreshold: 60 },
          readinessProbe: { tcpSocket: { port: "daemon" }, periodSeconds: 5 },
          livenessProbe: { tcpSocket: { port: "daemon" }, periodSeconds: 20, failureThreshold: 3 },
          resources: {
            requests: { cpu: "250m", memory: "512Mi" },
            limits: { cpu: "2", memory: "2Gi" },
          },
          volumeMounts: [
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
        { name: "data", persistentVolumeClaim: { claimName: name } },
        { name: "tmp", emptyDir: { sizeLimit: "512Mi" } },
      ],
    },
  };
  return { pvc, service, pod };
}
