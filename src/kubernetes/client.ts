import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import {
  CoreV1Api,
  CustomObjectsApi,
  createConfiguration,
  Exec,
  KubeConfig,
  ServerConfiguration,
  type V1ConfigMap,
  type V1Pod,
  type V1Secret,
  type V1Service,
} from "@kubernetes/client-node";
import { resourceName } from "../controller/resources.js";
import {
  API_GROUP,
  CredentialProfileSchema,
  ProjectSchema,
  WORKSPACE_UID_LABEL,
  type Workspace,
  WorkspaceSchema,
  type WorkspaceStatus,
} from "../domain.js";
import type { ControlRecord, RecordStore } from "./records.js";
import { type Infrastructure, type InfrastructureKind, type Store, statusCode } from "./store.js";

/** API responses are validated before entering the domain. API conflicts are retried by reconciliation. */
export class KubernetesStore implements Store, RecordStore {
  private readonly core: CoreV1Api;
  private readonly custom: CustomObjectsApi;

  constructor(
    private readonly config: KubeConfig,
    readonly namespace: string,
  ) {
    const cluster = config.getCurrentCluster();
    if (!cluster) throw new Error("No configured Kubernetes cluster");
    const settings = createConfiguration({
      baseServer: new ServerConfiguration(cluster.server, {}),
      authMethods: { default: config },
      promiseMiddleware: [
        {
          async pre(request) {
            request.setSignal(AbortSignal.timeout(10000));
            return request;
          },
          async post(response) {
            return response;
          },
        },
      ],
    });
    this.core = new CoreV1Api(settings);
    this.custom = new CustomObjectsApi(settings);
  }

  private parameters(plural: string) {
    return { group: API_GROUP, version: "v1alpha1", namespace: this.namespace, plural };
  }

  async projects() {
    const result = await this.custom.listNamespacedCustomObject(this.parameters("paseoprojects"));
    return ProjectSchema.array().parse(result.items);
  }

  async workspaces() {
    const result = await this.custom.listNamespacedCustomObject(this.parameters("paseoworkspaces"));
    return WorkspaceSchema.array().parse(result.items);
  }

  async createWorkspace(workspace: Workspace) {
    return WorkspaceSchema.parse(
      await this.custom.createNamespacedCustomObject({
        ...this.parameters("paseoworkspaces"),
        body: workspace,
      }),
    );
  }

  async setResidency(workspace: Workspace, residency: Workspace["spec"]["residency"]) {
    await this.custom.replaceNamespacedCustomObject({
      ...this.parameters("paseoworkspaces"),
      name: workspace.metadata.name,
      body: { ...workspace, spec: { ...workspace.spec, residency } },
    });
  }

  async status(workspace: Workspace, status: WorkspaceStatus) {
    await this.custom.replaceNamespacedCustomObjectStatus({
      ...this.parameters("paseoworkspaces"),
      name: workspace.metadata.name,
      body: { ...workspace, status },
    });
  }

  async get(kind: InfrastructureKind, name: string): Promise<Infrastructure | undefined> {
    const args = { namespace: this.namespace, name };
    try {
      switch (kind) {
        case "Pod":
          return await this.core.readNamespacedPod(args);
        case "Service":
          return await this.core.readNamespacedService(args);
        case "PersistentVolumeClaim":
          return await this.core.readNamespacedPersistentVolumeClaim(args);
      }
    } catch (error) {
      if (statusCode(error) === 404) return undefined;
      throw error;
    }
  }

  async create(object: Infrastructure): Promise<Infrastructure> {
    switch (object.kind) {
      // Generated Kubernetes models have string `kind` fields rather than discriminated unions.
      case "Pod":
        return await this.core.createNamespacedPod({
          namespace: this.namespace,
          body: object as V1Pod,
        });
      case "Service":
        return await this.core.createNamespacedService({
          namespace: this.namespace,
          body: object as V1Service,
        });
      case "PersistentVolumeClaim":
        return await this.core.createNamespacedPersistentVolumeClaim({
          namespace: this.namespace,
          body: object,
        });
      default:
        throw new Error("Unsupported infrastructure kind");
    }
  }

  async deletePod(name: string, uid: string) {
    await this.core.deleteNamespacedPod({
      namespace: this.namespace,
      name,
      body: { preconditions: { uid } },
    });
  }

  async deleteService(name: string, uid: string) {
    await this.core.deleteNamespacedService({
      namespace: this.namespace,
      name,
      body: { preconditions: { uid } },
    });
  }

  async deleteStorage(name: string, uid: string) {
    await this.core.deleteNamespacedPersistentVolumeClaim({
      namespace: this.namespace,
      name,
      body: { preconditions: { uid } },
    });
  }

  async deleteRuntime(workspace: Workspace): Promise<boolean> {
    if (!workspace.metadata.uid) throw new Error("Workspace UID required for runtime cleanup");
    const name = resourceName(workspace);
    const service = await this.get("Service", name);
    const secret = await this.readSecret(`${name}-access`);
    // Validate both before changing either. Shared provider/backend Secrets are never considered.
    for (const resource of [service, secret]) {
      if (
        resource &&
        (!resource.metadata?.uid ||
          resource.metadata.labels?.[WORKSPACE_UID_LABEL] !== workspace.metadata.uid)
      )
        throw new Error("Refusing to collect unowned workspace runtime resources");
    }
    if (service?.metadata?.uid && !service.metadata.deletionTimestamp)
      await this.core.deleteNamespacedService({
        namespace: this.namespace,
        name,
        body: { preconditions: { uid: service.metadata.uid } },
      });
    if (secret?.metadata?.uid && !secret.metadata.deletionTimestamp)
      await this.core.deleteNamespacedSecret({
        namespace: this.namespace,
        name: `${name}-access`,
        body: { preconditions: { uid: secret.metadata.uid } },
      });
    return !(await this.get("Service", name)) && !(await this.readSecret(`${name}-access`));
  }

  async teardown(workspace: Workspace) {
    const pod = await this.get("Pod", resourceName(workspace));
    if (!pod || pod.metadata?.labels?.[WORKSPACE_UID_LABEL] !== workspace.metadata.uid)
      throw new Error("Teardown requires an owned workspace pod");
    await new Promise<void>((resolve, reject) => {
      let socket: Awaited<ReturnType<Exec["exec"]>> | undefined;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.close();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("Teardown timed out; storage retained")),
        70000,
      );
      void new Exec(this.config)
        .exec(
          this.namespace,
          resourceName(workspace),
          "daemon",
          ["node", "/opt/paseo/teardown.mjs"],
          new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
          new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
          null,
          false,
          (status) =>
            finish(
              status.status === "Success"
                ? undefined
                : new Error("Teardown failed; storage retained"),
            ),
        )
        .then(
          (connection) => {
            socket = connection;
            if (settled) {
              socket.close();
              return;
            }
            socket.once("error", () =>
              finish(new Error("Teardown connection failed; inspect before retrying")),
            );
            socket.once("close", () =>
              finish(new Error("Teardown outcome unknown; storage retained")),
            );
          },
          () => finish(new Error("Teardown connection failed; storage retained")),
        );
    });
  }

  secret(name: string) {
    return this.core.readNamespacedSecret({ namespace: this.namespace, name });
  }

  configMap(name: string) {
    return this.core.readNamespacedConfigMap({ namespace: this.namespace, name });
  }

  async credentialProfile(name: string) {
    try {
      return CredentialProfileSchema.parse(
        await this.custom.getNamespacedCustomObject({
          ...this.parameters("paseocredentialprofiles"),
          name,
        }),
      );
    } catch (error) {
      if (statusCode(error) === 404) return undefined;
      throw error;
    }
  }

  async credentialProfiles() {
    const result = await this.custom.listNamespacedCustomObject(
      this.parameters("paseocredentialprofiles"),
    );
    const profiles = [];
    for (const item of result.items ?? []) {
      const parsed = CredentialProfileSchema.safeParse(item);
      if (parsed.success) profiles.push(parsed.data);
      else
        console.error(
          JSON.stringify({
            level: "error",
            event: "invalid_credential_profile",
            namespace: this.namespace,
          }),
        );
    }
    return profiles;
  }

  async readSecret(name: string): Promise<V1Secret | undefined> {
    try {
      return await this.secret(name);
    } catch (error) {
      if (statusCode(error) === 404) return undefined;
      throw error;
    }
  }

  async compareAndSwapSecret(
    name: string,
    expectedResourceVersion: string | undefined,
    secret: V1Secret,
  ): Promise<boolean> {
    const body = {
      ...secret,
      metadata: {
        ...secret.metadata,
        name,
        namespace: this.namespace,
        resourceVersion: expectedResourceVersion,
      },
    };
    try {
      if (expectedResourceVersion)
        await this.core.replaceNamespacedSecret({ name, namespace: this.namespace, body });
      else await this.core.createNamespacedSecret({ namespace: this.namespace, body });
      return true;
    } catch (error) {
      if (statusCode(error) === 409) return false;
      throw error;
    }
  }

  async workspaceLogs(workspace: Workspace, tailLines = 100): Promise<string> {
    const pod = await this.get("Pod", resourceName(workspace));
    if (pod?.metadata?.labels?.[WORKSPACE_UID_LABEL] !== workspace.metadata.uid)
      throw new Error("Workspace pod unavailable");
    return this.core.readNamespacedPodLog({
      namespace: this.namespace,
      name: resourceName(workspace),
      container: "daemon",
      tailLines: Math.min(Math.max(tailLines, 1), 1000),
      limitBytes: 65536,
      timestamps: true,
    });
  }

  private recordName(kind: string, id: string) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(kind) || !id || id.length > 512)
      throw new Error("Invalid control record identity");
    return `paseo-${kind}-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
  }

  private decodeRecord<T>(object: V1ConfigMap, kind: string): ControlRecord<T> {
    if (
      object.metadata?.labels?.[`${API_GROUP}/record-kind`] !== kind ||
      object.metadata?.labels?.["app.kubernetes.io/managed-by"] !== "paseo-kubernetes"
    )
      throw new Error("Refusing an unowned control record");
    const id = object.data?.id;
    if (!id || object.metadata.name !== this.recordName(kind, id) || !object.data?.value)
      throw new Error("Invalid control record");
    return {
      id,
      kind,
      version: object.metadata.resourceVersion,
      value: JSON.parse(object.data.value) as T,
    };
  }

  private encodeRecord<T>(record: ControlRecord<T>): V1ConfigMap {
    const value = JSON.stringify(record.value);
    if (Buffer.byteLength(value) > 700_000)
      throw new Error("Control record exceeds storage budget");
    return {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: this.recordName(record.kind, record.id),
        namespace: this.namespace,
        resourceVersion: record.version,
        labels: {
          "app.kubernetes.io/managed-by": "paseo-kubernetes",
          [`${API_GROUP}/record-kind`]: record.kind,
        },
      },
      data: { id: record.id, value },
    };
  }

  async records<T>(kind: string): Promise<ControlRecord<T>[]> {
    this.recordName(kind, "validate");
    const result = await this.core.listNamespacedConfigMap({
      namespace: this.namespace,
      labelSelector: `${API_GROUP}/record-kind=${kind},app.kubernetes.io/managed-by=paseo-kubernetes`,
    });
    return result.items.map((item) => this.decodeRecord<T>(item, kind));
  }

  async record<T>(kind: string, id: string): Promise<ControlRecord<T> | undefined> {
    try {
      return this.decodeRecord<T>(await this.configMap(this.recordName(kind, id)), kind);
    } catch (error) {
      if (statusCode(error) === 404) return undefined;
      throw error;
    }
  }

  async createRecord<T>(record: ControlRecord<T>): Promise<ControlRecord<T>> {
    return this.decodeRecord<T>(
      await this.core.createNamespacedConfigMap({
        namespace: this.namespace,
        body: this.encodeRecord(record),
      }),
      record.kind,
    );
  }

  async updateRecord<T>(record: ControlRecord<T>): Promise<ControlRecord<T>> {
    if (!record.version) throw new Error("Control record update requires resourceVersion");
    return this.decodeRecord<T>(
      await this.core.replaceNamespacedConfigMap({
        namespace: this.namespace,
        name: this.recordName(record.kind, record.id),
        body: this.encodeRecord(record),
      }),
      record.kind,
    );
  }

  async deleteRecord(record: ControlRecord): Promise<void> {
    if (!record.version) throw new Error("Control record deletion requires resourceVersion");
    await this.core.deleteNamespacedConfigMap({
      namespace: this.namespace,
      name: this.recordName(record.kind, record.id),
      body: { preconditions: { resourceVersion: record.version } },
    });
  }
}

export function loadKubernetesConfig(context?: string): KubeConfig {
  const config = new KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) config.loadFromCluster();
  else {
    if (!context) throw new Error("Set KUBE_CONTEXT explicitly for out-of-cluster use");
    config.loadFromDefault();
    config.setCurrentContext(context);
  }
  return config;
}
