import {
  CoreV1Api,
  CustomObjectsApi,
  createConfiguration,
  KubeConfig,
  ServerConfiguration,
  type V1Pod,
  type V1Service,
} from "@kubernetes/client-node";
import {
  API_GROUP,
  ProjectSchema,
  type Workspace,
  WorkspaceSchema,
  type WorkspaceStatus,
} from "../domain.js";
import { type Infrastructure, type InfrastructureKind, type Store, statusCode } from "./store.js";

/** API responses are validated before entering the domain. API conflicts are retried by reconciliation. */
export class KubernetesStore implements Store {
  private readonly core: CoreV1Api;
  private readonly custom: CustomObjectsApi;

  constructor(
    config: KubeConfig,
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

  async create(object: Infrastructure): Promise<void> {
    switch (object.kind) {
      // Generated Kubernetes models have string `kind` fields rather than discriminated unions.
      case "Pod":
        await this.core.createNamespacedPod({ namespace: this.namespace, body: object as V1Pod });
        break;
      case "Service":
        await this.core.createNamespacedService({
          namespace: this.namespace,
          body: object as V1Service,
        });
        break;
      case "PersistentVolumeClaim":
        await this.core.createNamespacedPersistentVolumeClaim({
          namespace: this.namespace,
          body: object,
        });
        break;
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

  secret(name: string) {
    return this.core.readNamespacedSecret({ namespace: this.namespace, name });
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
