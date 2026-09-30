import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
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
import { desiredHistoryReader, historyReaderName, resourceName } from "../controller/resources.js";
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

const MAX_HISTORY_OUTPUT = 2 * 1024 * 1024 + 65536;

function completedHistoryStop(workspace: Workspace): boolean {
  return (
    workspace.status?.observedGeneration === (workspace.metadata.generation ?? 1) &&
    ((workspace.spec.residency === "Suspended" && workspace.status.phase === "Suspended") ||
      (workspace.spec.residency === "Archived" &&
        workspace.status.phase === "Archived" &&
        !!workspace.status.teardownCompletedAt))
  );
}

/** API responses are validated before entering the domain. API conflicts are retried by reconciliation. */
export class KubernetesStore implements Store, RecordStore {
  private activeHistoryReaders = 0;
  private readonly historyReaderTails = new Map<string, Promise<void>>();
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

  private execHistory(
    podName: string,
    container: string,
    command: string[],
    input?: Buffer,
    timeoutMs = 35000,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let socket: Awaited<ReturnType<Exec["exec"]>> | undefined;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.close();
        if (error) reject(error);
        else resolve(Buffer.concat(chunks));
      };
      const timer = setTimeout(
        () => finish(new Error("Retained history operation timed out")),
        timeoutMs,
      );
      const stdout = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > MAX_HISTORY_OUTPUT) {
            finish(new Error("Retained history output exceeds budget"));
            callback();
            return;
          }
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      const stderr = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      void new Exec(this.config)
        .exec(
          this.namespace,
          podName,
          container,
          command,
          stdout,
          stderr,
          input ? Readable.from([input]) : null,
          false,
          (status) =>
            finish(
              status.status === "Success"
                ? undefined
                : new Error("Retained history operation failed"),
            ),
        )
        .then(
          (connection) => {
            socket = connection;
            if (settled) connection.close();
            else {
              connection.once("error", () =>
                finish(new Error("Retained history connection failed")),
              );
              connection.once("close", () => finish(new Error("Retained history outcome unknown")));
            }
          },
          () => finish(new Error("Retained history connection failed")),
        );
    });
  }

  /** Probe the actual running image, including custom and pre-upgrade images. */
  async supportsRetainedHistory(workspace: Workspace): Promise<boolean> {
    if (!workspace.metadata.uid) return false;
    const pod = await this.get("Pod", resourceName(workspace));
    if (!pod || pod.metadata?.labels?.[WORKSPACE_UID_LABEL] !== workspace.metadata.uid)
      throw new Error("Owned workspace Pod is unavailable for retained history");
    const answer = await this.execHistory(
      resourceName(workspace),
      "daemon",
      [
        "node",
        "-e",
        "process.stdout.write(require('node:fs').existsSync('/opt/paseo/retained-history.mjs')?'v1':'none')",
      ],
      undefined,
      10000,
    );
    if (answer.toString("utf8") === "v1") return true;
    if (answer.toString("utf8") === "none") return false;
    throw new Error("Invalid retained history capability response");
  }

  async writeRetainedHistory(workspace: Workspace, payload: Buffer): Promise<string> {
    if (!workspace.metadata.uid || payload.byteLength > 8 * 1024 * 1024)
      throw new Error("Invalid retained history identity or size");
    const pod = await this.get("Pod", resourceName(workspace));
    if (
      !pod ||
      pod.metadata?.labels?.[WORKSPACE_UID_LABEL] !== workspace.metadata.uid ||
      pod.metadata?.deletionTimestamp
    )
      throw new Error("Owned workspace Pod is unavailable for retained history");
    const answer = await this.execHistory(
      resourceName(workspace),
      "daemon",
      ["node", "/opt/paseo/retained-history.mjs", "write", workspace.metadata.uid],
      payload,
    );
    const fileName = answer.toString("utf8").trim();
    if (!new RegExp(`^${workspace.metadata.uid}-\\d+-\\d{13}-[a-f0-9-]+\\.json$`).test(fileName))
      throw new Error("Invalid retained history write receipt");
    return fileName;
  }

  async pruneRetainedHistory(workspace: Workspace, fileName?: string): Promise<void> {
    const uid = workspace.metadata.uid;
    if (!uid || (fileName && !new RegExp(`^${uid}-\\d+-\\d{13}-[a-f0-9-]+\\.json$`).test(fileName)))
      throw new Error("Invalid retained history prune identity");
    const pod = await this.get("Pod", resourceName(workspace));
    if (
      !pod ||
      pod.metadata?.labels?.[WORKSPACE_UID_LABEL] !== uid ||
      pod.metadata?.deletionTimestamp
    )
      throw new Error("Owned workspace Pod is unavailable for retained history cleanup");
    await this.execHistory(
      resourceName(workspace),
      "daemon",
      ["node", "/opt/paseo/retained-history.mjs", "prune", uid, ...(fileName ? [fileName] : [])],
      undefined,
      10000,
    );
  }

  private async readerPod(workspace: Workspace, image: string, check: () => void): Promise<V1Pod> {
    const uid = workspace.metadata.uid;
    if (!uid) throw new Error("Workspace UID required for retained history");
    const pvc = await this.get("PersistentVolumeClaim", resourceName(workspace));
    const pvcUid = pvc?.metadata?.uid;
    check();
    if (
      !pvcUid ||
      pvc.metadata?.labels?.[WORKSPACE_UID_LABEL] !== uid ||
      pvc.metadata?.deletionTimestamp
    )
      throw new Error("Owned retained workspace storage is unavailable");
    const name = historyReaderName(workspace);
    // Deletion is acknowledged before the Pod name necessarily disappears.
    // A later read may wait for its own terminating helper, but never adopt a
    // foreign or still-active Pod. The caller's request deadline bounds this.
    let terminatingUid: string | undefined;
    while (true) {
      const existing = await this.get("Pod", name);
      check();
      if (!existing) break;
      if (
        !existing.metadata?.uid ||
        existing.metadata?.labels?.[WORKSPACE_UID_LABEL] !== uid ||
        existing.metadata.labels["app.kubernetes.io/component"] !== "history-reader" ||
        !existing.metadata.ownerReferences?.some(
          (owner) =>
            owner.uid === uid &&
            owner.apiVersion === workspace.apiVersion &&
            owner.kind === workspace.kind &&
            owner.name === workspace.metadata.name &&
            owner.controller === true,
        ) ||
        !existing.metadata.deletionTimestamp ||
        (terminatingUid && existing.metadata.uid !== terminatingUid)
      )
        throw new Error("Retained history reader is already active; retry later");
      terminatingUid = existing.metadata.uid;
      await new Promise((resolve) => setTimeout(resolve, 250));
      check();
    }
    const current = (await this.workspaces()).find(
      (row) => row.metadata.name === workspace.metadata.name,
    );
    check();
    if (
      !current ||
      current.metadata.uid !== uid ||
      current.metadata.generation !== workspace.metadata.generation ||
      current.metadata.resourceVersion !== workspace.metadata.resourceVersion ||
      current.spec.residency !== workspace.spec.residency ||
      current.status?.phase !== workspace.status?.phase ||
      current.spec.projectRef !== workspace.spec.projectRef ||
      current.spec.credentialProfile !== workspace.spec.credentialProfile ||
      current.spec.retentionPolicy?.storage !== workspace.spec.retentionPolicy?.storage ||
      current.status?.storageDeletedAt ||
      current.metadata.deletionTimestamp ||
      !completedHistoryStop(current)
    )
      throw new Error("Retained history workspace changed before reader creation");
    const currentPvc = await this.get("PersistentVolumeClaim", resourceName(workspace));
    check();
    if (
      !currentPvc ||
      currentPvc.metadata?.uid !== pvcUid ||
      currentPvc.metadata?.labels?.[WORKSPACE_UID_LABEL] !== uid ||
      currentPvc.metadata?.deletionTimestamp
    )
      throw new Error("Owned retained workspace storage changed before reader creation");
    return this.core.createNamespacedPod({
      namespace: this.namespace,
      body: desiredHistoryReader(workspace, image, this.namespace),
    });
  }

  /** A read-only, credential-free helper mounts only the exact UID-owned PVC. */
  async readRetainedHistory(
    workspace: Workspace,
    agentId: string,
    image: string,
    fileName: string,
    deadlineAt = Date.now() + 35000,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const uid = workspace.metadata.uid;
    if (
      !uid ||
      workspace.metadata.deletionTimestamp ||
      !completedHistoryStop(workspace) ||
      workspace.spec.retentionPolicy?.storage === "Ephemeral" ||
      workspace.status?.storageDeletedAt
    )
      throw new Error("Retained workspace storage is unavailable");
    if (this.activeHistoryReaders >= 4)
      throw new Error("Retained history reader capacity reached; retry later");
    this.activeHistoryReaders++;
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const previousTurn = this.historyReaderTails.get(uid);
    // Keep the tail transitive: if this queued call cancels before its
    // predecessor finishes, later calls must still wait for that predecessor.
    const tail = previousTurn ? previousTurn.then(() => turn) : turn;
    this.historyReaderTails.set(uid, tail);
    void tail.then(() => {
      if (this.historyReaderTails.get(uid) === tail) this.historyReaderTails.delete(uid);
    });
    const deadline = Math.min(deadlineAt, Date.now() + 35000);
    const check = () => {
      if (signal?.aborted) throw new Error("Gateway session closed");
      if (Date.now() >= deadline) throw new Error("Retained history reader deadline exceeded");
    };
    const bounded = async <T>(run: () => Promise<T>): Promise<T> => {
      check();
      const operation = run();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        const stopped = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Retained history reader deadline exceeded")),
            Math.max(1, deadline - Date.now()),
          );
          timer.unref();
          abort = () => reject(new Error("Gateway session closed"));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
        const result = await Promise.race([operation, stopped]);
        check();
        return result;
      } finally {
        if (timer) clearTimeout(timer);
        if (abort) signal?.removeEventListener("abort", abort);
      }
    };
    const name = historyReaderName(workspace);
    let readerUid: string | undefined;
    try {
      if (previousTurn) await bounded(() => previousTurn);
      check();
      const creation = this.readerPod(workspace, image, check);
      // A create already sent to Kubernetes can ACK after timeout or close.
      // Delete only that returned Pod UID; startup recovery handles a lost ACK.
      void creation
        .then((pod) => {
          if ((signal?.aborted || Date.now() >= deadline) && pod.metadata?.uid)
            void this.deletePod(name, pod.metadata.uid).catch(() => undefined);
        })
        .catch(() => undefined);
      const created = await bounded(() => creation);
      readerUid = created.metadata?.uid;
      if (!readerUid) throw new Error("Retained history reader UID unavailable");
      const startupDeadline = Math.min(deadline, Date.now() + 15000);
      while (Date.now() < startupDeadline) {
        const pod = (await bounded(() => this.get("Pod", name))) as V1Pod | undefined;
        if (!pod || pod.metadata?.uid !== readerUid) throw new Error("History reader was replaced");
        if (pod.status?.phase === "Running") break;
        if (pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded")
          throw new Error("History reader failed to start");
        await bounded(() => new Promise((resolve) => setTimeout(resolve, 250)));
      }
      const pod = (await bounded(() => this.get("Pod", name))) as V1Pod | undefined;
      if (pod?.metadata?.uid !== readerUid || pod.status?.phase !== "Running")
        throw new Error("History reader startup timed out");
      const current = (await bounded(() => this.workspaces())).find(
        (row) => row.metadata.name === workspace.metadata.name,
      );
      if (
        !current ||
        current.metadata.uid !== uid ||
        current.metadata.generation !== workspace.metadata.generation ||
        current.spec.residency !== workspace.spec.residency ||
        current.status?.storageDeletedAt
      )
        throw new Error("Retained history workspace changed during reader startup");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Retained history reader deadline exceeded");
      const bytes = await bounded(() =>
        this.execHistory(
          name,
          "reader",
          [
            "node",
            "/opt/paseo/retained-history.mjs",
            "read",
            uid,
            agentId,
            String(workspace.metadata.generation ?? 1),
            fileName,
          ],
          undefined,
          Math.min(12000, remaining),
        ),
      );
      return JSON.parse(bytes.toString("utf8"));
    } finally {
      if (readerUid)
        await Promise.race([
          this.deletePod(name, readerUid).catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]);
      releaseTurn();
      this.activeHistoryReaders--;
    }
  }

  /** Called at startup and periodically; Pod TTL also stops orphaned compute. */
  async cleanupRetainedHistoryReaders(): Promise<void> {
    for (const workspace of await this.workspaces()) {
      if (!workspace.metadata.uid) continue;
      const pod = await this.get("Pod", historyReaderName(workspace));
      if (
        pod?.metadata?.uid &&
        pod.metadata.labels?.[WORKSPACE_UID_LABEL] === workspace.metadata.uid &&
        pod.metadata.labels?.["app.kubernetes.io/component"] === "history-reader" &&
        Date.now() - new Date(pod.metadata.creationTimestamp ?? 0).getTime() > 120000
      )
        await this.deletePod(historyReaderName(workspace), pod.metadata.uid);
    }
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
