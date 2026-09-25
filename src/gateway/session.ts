import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  decodeFileTransferFrame,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  type AgentSnapshotPayload,
  AgentSnapshotPayloadSchema,
  type SessionInboundMessage,
  SessionInboundMessageSchema,
  type SessionOutboundMessage,
  SessionOutboundMessageSchema,
  type WorkspaceDescriptorPayload,
  type WSHelloMessage,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import { resourceName } from "../controller/resources.js";
import {
  API_VERSION,
  type Project,
  parseScopedId,
  projectPath,
  type Workspace,
  workspacePath,
} from "../domain.js";
import type { RecordStore } from "../kubernetes/records.js";
import type { Store } from "../kubernetes/store.js";
import { readArchivedInventory } from "./agent-inventory.js";
import type { AgentRouting } from "./agent-routing.js";
import {
  authorizeProject,
  authorizeWorkspace,
  type GatewayPrincipal,
  principalIsActive,
  type ScopedAuthOptions,
} from "./auth.js";
import { type Backend, PaseoBackend } from "./backend.js";
import {
  type DirectoryGeneration,
  DirectoryPages,
  projectDescriptor,
  sortAgents,
  sortWorkspaces,
  workspaceDescriptor,
} from "./catalog.js";
import type { DownloadHandles } from "./downloads.js";
import { normalizeProjectBranchName } from "./project-ref-selection.js";
import type { ProjectRefInspector, ProjectRefQuery } from "./project-refs.js";
import { projectForCatalogPath } from "./provider-catalog.js";
import type { ProviderCatalog } from "./provider-catalog-service.js";
import { type JsonObject, object, selectWorkspace, TerminalSlots, translate } from "./routing.js";
import type { GatewayRuntime } from "./runtime-status.js";
import { UploadStaging } from "./uploads.js";
import { WorkspaceLabels } from "./workspace-labels.js";

const forwarded = new Set([
  "create_agent_request",
  "agent.create.request",
  "fetch_agent_request",
  "send_agent_message_request",
  "cancel_agent_request",
  "archive_agent_request",
  "delete_agent_request",
  "update_agent_request",
  "resume_agent_request",
  "refresh_agent_request",
  "fetch_agent_timeline_request",
  "agent.timeline.set_subscription.request",
  "agent_permission_response",
  "set_agent_mode_request",
  "set_agent_model_request",
  "set_agent_thinking_request",
  "set_agent_feature_request",
  "clear_agent_attention",
  "wait_for_finish_request",
  "list_commands_request",
  "file_explorer_request",
  "file.upload.request",
  "file_download_token_request",
  "list_terminals_request",
  "subscribe_terminals_request",
  "unsubscribe_terminals_request",
  "create_terminal_request",
  "terminal.rename.request",
  "subscribe_terminal_request",
  "unsubscribe_terminal_request",
  "terminal_input",
  "kill_terminal_request",
  "capture_terminal_request",
  "workspace_setup_status_request",
  "subscribe_checkout_diff_request",
  "unsubscribe_checkout_diff_request",
  "branch_suggestions_request",
  "validate_branch_request",
  "stash_list_request",
  "stash_save_request",
  "stash_pop_request",
]);
const providerRequests = new Set([
  "get_providers_snapshot_request",
  "refresh_providers_snapshot_request",
  "list_available_providers_request",
  "list_provider_models_request",
  "list_provider_modes_request",
  "list_provider_features_request",
  "provider_diagnostic_request",
  "provider.usage.list.request",
]);

export interface SessionOptions {
  checkoutRpcTimeoutMs?: number;
  projectRefRpcTimeoutMs?: number;
  runtime?: GatewayRuntime;
  inventoryStore?: RecordStore;
  agentRouting?: AgentRouting;
  labels?: WorkspaceLabels;
  downloadHandles?: DownloadHandles;
  principal?: GatewayPrincipal;
  scopedAuth?: ScopedAuthOptions;
  operations?: {
    creationLifecycle?: boolean;
    close?(emit: SessionOptions["emit"]): void;
    handle(
      message: SessionInboundMessage,
      emit: SessionOptions["emit"],
      principal: GatewayPrincipal,
      uploads?: UploadStaging,
    ): Promise<boolean>;
  };
  store: Store;
  namespace: string;
  backendPassword: string;
  backendSecure?: boolean;
  providerCatalog?: Pick<ProviderCatalog, "snapshot" | "watch" | "checkoutStatus"> & {
    identity(project: Project): Promise<{ fingerprint: string }>;
  };
  projectRefs?: Pick<ProjectRefInspector, "query">;
  directory: DirectoryGeneration;
  hello: WSHelloMessage;
  emit: (message: SessionOutboundMessage | JsonObject) => void;
  emitBinary: (data: Uint8Array) => void;
  disconnect: () => void;
  backendFactory?: (
    workspace: Workspace,
    onMessage: (message: SessionOutboundMessage) => void,
    onBinary: (data: Uint8Array) => void,
    disconnect: () => void,
  ) => Backend;
}

/** One backend session per client/workspace isolates subscriptions, request IDs and binary channels. */
export class GatewaySession {
  private readonly connections = new Map<
    string,
    Promise<{
      backend: Backend;
      workspace: Workspace;
      localId: string;
      retire: () => void;
      drain: () => Promise<void>;
      enqueue: <T>(work: () => Promise<T>) => Promise<T>;
    }>
  >();
  private readonly slots = new TerminalSlots();
  private readonly pages = new DirectoryPages();
  private readonly uploads: UploadStaging;
  private readonly subscriptions = new Map<string, string>();
  private readonly providerWatches = new Map<string, { projectUid: string; release: () => void }>();
  private closed = false;
  private watchingWorkspaces = false;
  private refreshing = false;
  private readonly workspaceRuntime = new Map<string, WorkspaceDescriptorPayload>();
  private readonly workspaceProjections = new Map<string, string>();
  private readonly labels?: WorkspaceLabels;
  constructor(private readonly options: SessionOptions) {
    this.uploads = new UploadStaging((message) => options.emit(message));
    this.labels =
      options.labels ??
      (options.inventoryStore
        ? new WorkspaceLabels(options.inventoryStore, options.store, options.directory)
        : undefined);
  }

  private async project(value: unknown, workspace: Workspace, localId: string) {
    const translated = translate(value, workspace, localId, "out");
    return this.options.agentRouting
      ? this.options.agentRouting.project(translated, workspace)
      : translated;
  }

  private async connection(workspace: Workspace) {
    if (!authorizeWorkspace(this.options.principal ?? { kind: "owner" }, workspace))
      throw new Error("Workspace access denied");
    const id = workspace.metadata.name;
    const previous = this.connections.get(id);
    if (workspace.spec.residency !== "Running" || workspace.status?.phase !== "Ready") {
      throw new Error(
        `Workspace ${id} is ${workspace.status?.phase ?? "Pending"}; inventory is unavailable, not deleted`,
      );
    }
    if (previous) {
      const connected = await previous;
      if (connected.workspace.metadata.uid !== workspace.metadata.uid) {
        connected.retire();
        await connected.backend.close();
        this.connections.delete(id);
        this.workspaceRuntime.delete(id);
        throw new Error("Workspace identity changed; reconnect before acting");
      }
      return connected;
    }
    const promise = (async () => {
      let localId = workspace.status?.backendWorkspaceId ?? "";
      let retired = false;
      let eventTail: Promise<void> = Promise.resolve();
      let pendingEvents = 0;
      let pendingEventBytes = 0;
      const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
        const result = eventTail.then(work);
        eventTail = result.then(
          () => {},
          () => {},
        );
        return result;
      };
      const onMessage = (message: SessionOutboundMessage) => {
        if (this.closed || retired) return;
        if (message.type === "status" && message.payload.status === "server_info") return;
        if (message.type === "project.update") return;
        if (message.type === "workspace_update") {
          // Backend removals never delete cluster records; only project this checkout's runtime.
          if (message.payload.kind === "upsert" && message.payload.workspace.id === localId) {
            this.workspaceRuntime.set(id, message.payload.workspace);
            void this.refreshDirectory().catch(() => this.options.disconnect());
          }
          return;
        }
        const eventBytes = Buffer.byteLength(JSON.stringify(message));
        pendingEvents++;
        pendingEventBytes += eventBytes;
        if (pendingEvents > 256 || pendingEventBytes > 16 * 1024 * 1024) {
          this.options.disconnect();
          return;
        }
        eventTail = enqueue(async () => {
          if (this.closed || retired) return;
          const translated = object(await this.project(message, workspace, localId));
          if (this.closed || retired) return;
          if (message.type === "agent_update") {
            const payload = object(translated.payload);
            payload.generation = this.options.directory.id;
            payload.seq = this.options.directory.next();
          }
          this.options.emit(translated);
        })
          .catch(() => this.options.disconnect())
          .finally(() => {
            pendingEvents--;
            pendingEventBytes -= eventBytes;
          });
      };
      const onBinary = (data: Uint8Array) => {
        if (this.closed || retired) return;
        const terminal = decodeTerminalStreamFrame(data);
        this.options.emitBinary(
          terminal
            ? encodeTerminalStreamFrame({
                ...terminal,
                slot: this.slots.outward(id, terminal.slot),
              })
            : data,
        );
      };
      const backend =
        this.options.backendFactory?.(workspace, onMessage, onBinary, this.options.disconnect) ??
        new PaseoBackend(
          `${this.options.backendSecure ? "wss" : "ws"}://${resourceName(workspace)}.${this.options.namespace}.svc:6767/ws`,
          this.options.backendPassword,
          this.options.hello,
          onMessage,
          onBinary,
          this.options.disconnect,
        );
      try {
        await backend.connect();
        if (this.closed) throw new Error("Client disconnected");
        // open_project is upstream's directory-deduplicating registration operation, not workspace.create.
        const opened = await backend.request({
          type: "open_project_request",
          cwd: workspacePath(id),
          requestId: randomUUID(),
        });
        if (opened.type !== "open_project_response" || !opened.payload.workspace)
          throw new Error("Workspace registration failed");
        localId = opened.payload.workspace.id;
        this.workspaceRuntime.set(id, opened.payload.workspace);
        const snapshot = await backend.request({
          type: "fetch_workspaces_request",
          requestId: randomUUID(),
          subscribe: {},
          page: { limit: 200 },
        });
        if (snapshot.type !== "fetch_workspaces_response")
          throw new Error("Workspace subscription failed");
        const runtime = snapshot.payload.entries.find((entry) => entry.id === localId);
        if (runtime) this.workspaceRuntime.set(id, runtime);
        return {
          backend,
          workspace,
          localId,
          retire: () => {
            retired = true;
          },
          drain: () => eventTail,
          enqueue,
        };
      } catch (error) {
        await backend.close();
        this.connections.delete(id);
        throw error;
      }
    })();
    this.connections.set(id, promise);
    return promise;
  }

  private async records() {
    const [projects, workspaces] = await Promise.all([
      this.options.store.projects(),
      this.options.store.workspaces(),
    ]);
    const principal = this.options.principal ?? { kind: "owner" };
    if (!principalIsActive(principal, workspaces))
      throw new Error("Workspace credential expired or revoked");
    if (
      principal.kind === "workspace" &&
      this.options.scopedAuth?.revokedTokenIds?.has(principal.tokenId)
    )
      throw new Error("Workspace credential expired or revoked");
    return {
      projects: projects.filter(
        (project) =>
          authorizeProject(principal, project.metadata.name) &&
          (principal.kind === "owner" ||
            principal.credentialProfiles.includes(project.spec.credentialProfile)),
      ),
      workspaces: workspaces.filter(
        (w) => !w.metadata.deletionTimestamp && authorizeWorkspace(principal, w),
      ),
    };
  }

  private projectFor(workspace: Workspace, projects: Project[]) {
    const project = projects.find((p) => p.metadata.name === workspace.spec.projectRef);
    if (!project) throw new Error("Workspace project no longer exists");
    return project;
  }

  private async scopedProviderSnapshot(
    catalog: Pick<ProviderCatalog, "snapshot"> & {
      identity(project: Project): Promise<{ fingerprint: string }>;
    },
    project: Project,
    force = false,
  ) {
    let originalFingerprint: string;
    try {
      originalFingerprint = (await catalog.identity(project)).fingerprint;
    } catch {
      // The catalog schedules a bounded retry when broker output is absent.
      await catalog.snapshot(project, force);
      throw new Error("Provider discovery configuration is unavailable");
    }
    const entries = await catalog.snapshot(project, force);
    const current = projectForCatalogPath(
      projectPath(project.metadata.name),
      (await this.records()).projects,
    );
    if (!current || current.metadata.uid !== project.metadata.uid)
      throw new Error("Provider catalog project access changed");
    if ((await catalog.identity(current)).fingerprint !== originalFingerprint)
      throw new Error("Provider catalog configuration changed");
    // The final identity read can await Secret/ConfigMap API calls. Recheck the
    // caller and Project after that await so revocation cannot leak a snapshot.
    const finalProject = projectForCatalogPath(
      projectPath(project.metadata.name),
      (await this.records()).projects,
    );
    if (
      !finalProject ||
      finalProject.metadata.uid !== current.metadata.uid ||
      JSON.stringify(finalProject.spec) !== JSON.stringify(current.spec)
    )
      throw new Error("Provider catalog project access or configuration changed");
    return entries;
  }

  private async scopedCheckoutStatus(
    catalog: Pick<ProviderCatalog, "checkoutStatus"> & {
      identity(project: Project): Promise<{ fingerprint: string }>;
    },
    project: Project,
  ) {
    const originalFingerprint = (await catalog.identity(project)).fingerprint;
    const status = await catalog.checkoutStatus(project);
    const current = projectForCatalogPath(
      projectPath(project.metadata.name),
      (await this.records()).projects,
    );
    if (!current || current.metadata.uid !== project.metadata.uid)
      throw new Error("Project checkout access changed");
    if ((await catalog.identity(current)).fingerprint !== originalFingerprint)
      throw new Error("Project checkout configuration changed");
    const finalProject = projectForCatalogPath(
      projectPath(project.metadata.name),
      (await this.records()).projects,
    );
    if (
      !finalProject ||
      finalProject.metadata.uid !== current.metadata.uid ||
      JSON.stringify(finalProject.spec) !== JSON.stringify(current.spec)
    )
      throw new Error("Project checkout access or configuration changed");
    return status;
  }

  private async scopedProjectRefs(project: Project, query: ProjectRefQuery) {
    const catalog = this.options.providerCatalog;
    const inspector = this.options.projectRefs;
    if (!catalog || !inspector) throw new Error("Project ref inspection is unavailable");
    const identity = await catalog.identity(project);
    const profile = await this.options.store.credentialProfile(project.spec.credentialProfile);
    if (!profile || profile.metadata.namespace !== project.metadata.namespace)
      throw new Error("Project ref credential profile is unavailable");
    if ((await catalog.identity(project)).fingerprint !== identity.fingerprint)
      throw new Error("Project ref configuration changed");
    const result = await inspector.query({ project, profile, query });
    const current = projectForCatalogPath(
      projectPath(project.metadata.name),
      (await this.records()).projects,
    );
    if (!current || current.metadata.uid !== project.metadata.uid)
      throw new Error("Project ref access changed");
    if ((await catalog.identity(current)).fingerprint !== identity.fingerprint)
      throw new Error("Project ref configuration changed");
    const finalProject = projectForCatalogPath(
      projectPath(project.metadata.name),
      (await this.records()).projects,
    );
    if (
      !finalProject ||
      finalProject.metadata.uid !== current.metadata.uid ||
      JSON.stringify(finalProject.spec) !== JSON.stringify(current.spec)
    )
      throw new Error("Project ref access or configuration changed");
    return result;
  }

  async handle(message: SessionInboundMessage) {
    if (this.closed) return;
    const record = object(message);
    const requestId = typeof record.requestId === "string" ? record.requestId : undefined;
    const projectCheckout =
      (message.type === "checkout_status_request" ||
        message.type === "branch_suggestions_request" ||
        message.type === "validate_branch_request") &&
      message.cwd.startsWith("/projects/");
    const checkoutDeadline = projectCheckout
      ? Date.now() +
        (message.type === "checkout_status_request"
          ? (this.options.checkoutRpcTimeoutMs ?? 45_000)
          : (this.options.projectRefRpcTimeoutMs ?? 58_000))
      : undefined;
    let checkoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = this.dispatch(message, checkoutDeadline);
      if (checkoutDeadline === undefined) await work;
      else
        await Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            checkoutTimer = setTimeout(
              () => reject(new Error("Project checkout discovery timed out; retry shortly")),
              Math.max(1, checkoutDeadline - Date.now()),
            );
          }),
        ]);
    } catch (error) {
      if (!this.closed && requestId)
        this.options.emit({
          type: "rpc_error",
          payload: {
            requestId,
            requestType: message.type,
            code: "gateway_operation_failed",
            error: error instanceof Error ? error.message : "Gateway operation failed",
          },
        });
    } finally {
      if (checkoutTimer) clearTimeout(checkoutTimer);
    }
  }

  private async dispatch(message: SessionInboundMessage, checkoutDeadline?: number) {
    const record = object(message);
    const requestId = typeof record.requestId === "string" ? record.requestId : "";
    const { projects, workspaces } = await this.records();
    if (message.type === "file.upload.request") {
      this.uploads.begin(message);
      return;
    }
    if (
      await this.options.operations?.handle(
        message,
        this.options.emit,
        this.options.principal ?? { kind: "owner" },
        this.uploads,
      )
    )
      return;
    const active = workspaces.filter((w) => w.spec.residency !== "Archived");
    if (message.type === "daemon.get_status.request") {
      if (!this.options.runtime) throw new Error("Gateway runtime status is unavailable");
      const providers = new Map<
        string,
        { provider: string; available: boolean; error: string | null }
      >();
      let providersComplete = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const observed = Promise.all(
        active
          .filter(
            (workspace) =>
              workspace.spec.residency === "Running" && workspace.status?.phase === "Ready",
          )
          .map(async (workspace) => {
            try {
              const { backend } = await this.connection(workspace);
              const snapshot = await backend.request({
                type: "get_providers_snapshot_request",
                requestId: randomUUID(),
                cwd: workspacePath(workspace.metadata.name),
              });
              if (snapshot.type !== "get_providers_snapshot_response")
                throw new Error("Provider snapshot unavailable");
              for (const entry of snapshot.payload.entries) {
                const available = entry.status === "ready" && entry.enabled;
                const previous = providers.get(entry.provider);
                providers.set(entry.provider, {
                  provider: entry.provider,
                  available: available || !!previous?.available,
                  error: available || previous?.available ? null : `Provider ${entry.status}`,
                });
              }
            } catch {
              providersComplete = false;
            }
          }),
      );
      // The upstream CLI probes status with a 1.5-second deadline; slow workspaces
      // must not make a responsive gateway look down. Partial catalogs are explicit.
      await Promise.race([
        observed,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            providersComplete = false;
            resolve();
          }, 500);
        }),
      ]);
      clearTimeout(timer);
      this.options.emit({
        type: "daemon.get_status.response",
        payload: {
          ...this.options.runtime,
          requestId,
          relay: null,
          providers: [...providers.values()],
          providersComplete,
          implementation: "paseo-gateway",
          protocolVersion: "0.9.1",
          workspaceCount: workspaces.length,
        },
      });
      return;
    }
    if (message.type === "project.list.request") {
      this.options.emit({
        type: "project.list.response",
        payload: {
          requestId,
          projects: projects.map((p) => ({
            ...projectDescriptor(p),
            syncSeq: this.options.directory.next(),
          })),
          sync: this.options.directory.snapshot(message.sync?.generation),
        },
      });
      return;
    }
    if (message.type === "fetch_workspaces_request") {
      this.watchingWorkspaces ||= !!message.subscribe;
      const pageKey = JSON.stringify({
        type: message.type,
        filter: message.filter,
        sort: message.sort,
      });
      if (message.page?.cursor) {
        this.options.emit({
          type: "fetch_workspaces_response",
          payload: {
            requestId,
            ...this.pages.read(pageKey, message.page),
            emptyProjects: [],
            subscriptionId: message.subscribe?.subscriptionId ?? null,
            sync: this.options.directory.snapshot(message.sync?.generation),
          },
        });
        return;
      }
      await Promise.allSettled(
        active
          .filter((w) => w.spec.residency === "Running" && w.status?.phase === "Ready")
          .map((w) => this.connection(w)),
      );
      const visible = active.filter(
        (w) => !message.filter?.projectId || w.spec.projectRef === message.filter.projectId,
      );
      const labels = await this.labels?.workspaceLabelsMany(visible);
      let rows = visible.map((w) => ({
        ...workspaceDescriptor(
          w,
          this.projectFor(w, projects),
          w.spec.residency === "Running" && w.status?.phase === "Ready"
            ? this.workspaceRuntime.get(w.metadata.name)
            : undefined,
        ),
        labels: labels?.get(w.metadata.name) ?? [],
        syncSeq: this.options.directory.next(),
      }));
      if (message.filter?.query) {
        const q = message.filter.query.toLowerCase();
        rows = rows.filter(
          (w) => w.name.toLowerCase().includes(q) || w.id.toLowerCase().includes(q),
        );
      }
      sortWorkspaces(rows, message.sort);
      this.options.emit({
        type: "fetch_workspaces_response",
        payload: {
          requestId,
          ...this.pages.read(pageKey, message.page, rows),
          emptyProjects: projects
            .filter((p) => !active.some((w) => w.spec.projectRef === p.metadata.name))
            .map(projectDescriptor),
          subscriptionId: message.subscribe?.subscriptionId ?? null,
          sync: this.options.directory.snapshot(message.sync?.generation),
        },
      });
      return;
    }
    if (message.type === "workspace.create.request") {
      const source = message.source;
      const id =
        source.projectId ??
        projects.find(
          (p) =>
            projectPath(p.metadata.name) ===
            (source.kind === "directory" ? source.path : source.cwd),
        )?.metadata.name;
      const project = projects.find((p) => p.metadata.name === id);
      if (!project) throw new Error("Select a configured Kubernetes project");
      if (source.kind === "worktree" && (source.checkoutSource || source.githubPrNumber))
        throw new Error("Pull request checkout is not supported in this POC");
      const name = `w-${randomUUID()}`;
      const workspace = await this.options.store.createWorkspace({
        apiVersion: API_VERSION,
        kind: "PaseoWorkspace",
        metadata: { name, namespace: this.options.namespace },
        spec: {
          projectRef: project.metadata.name,
          displayName: message.title ?? name,
          residency: "Running",
          credentialProfile: project.spec.credentialProfile,
          revision:
            source.kind === "worktree"
              ? (source.baseBranch ?? source.refName ?? project.spec.revision)
              : project.spec.revision,
          ...(source.kind === "worktree" && source.branchName ? { branch: source.branchName } : {}),
        },
      });
      const descriptor = workspaceDescriptor(workspace, project);
      this.options.emit({
        type: "workspace.create.response",
        payload: { requestId, workspace: descriptor, setupTerminalId: null, error: null },
      });
      this.options.emit({
        type: "workspace_update",
        payload: {
          kind: "upsert",
          workspace: descriptor,
          generation: this.options.directory.id,
          seq: this.options.directory.next(),
        },
      });
      return;
    }
    if (message.type === "archive_workspace_request") {
      const workspace = workspaces.find((w) => w.metadata.name === message.workspaceId);
      if (!workspace) throw new Error("Workspace does not exist");
      await this.options.store.setResidency(workspace, "Archived");
      this.options.emit({
        type: "archive_workspace_response",
        payload: {
          requestId,
          workspaceId: workspace.metadata.name,
          archivedAt: new Date().toISOString(),
          error: null,
        },
      });
      this.options.emit({
        type: "workspace_update",
        payload: {
          kind: "remove",
          id: workspace.metadata.name,
          generation: this.options.directory.id,
          seq: this.options.directory.next(),
        },
      });
      return;
    }
    if (message.type === "fetch_agents_request" || message.type === "fetch_agent_history_request") {
      const pageKey = JSON.stringify({
        type: message.type,
        filter: message.filter,
        sort: message.sort,
        scope: "scope" in message ? message.scope : undefined,
        search: "search" in message ? message.search : undefined,
      });
      if (message.page?.cursor) {
        this.options.emit({
          type:
            message.type === "fetch_agents_request"
              ? "fetch_agents_response"
              : "fetch_agent_history_response",
          payload: {
            requestId,
            ...this.pages.read(pageKey, message.page),
            ...(message.type === "fetch_agents_request"
              ? {
                  subscriptionId: message.subscribe?.subscriptionId ?? null,
                  sync: this.options.directory.snapshot(message.sync?.generation),
                }
              : {}),
          },
        });
        return;
      }
      const entries: { agent: AgentSnapshotPayload }[] = [];
      const inventory = message.filter?.includeArchived ? workspaces : active;
      for (const workspace of inventory.filter(
        (w) =>
          !message.filter?.projectKeys?.length ||
          message.filter.projectKeys.includes(w.spec.projectRef),
      )) {
        if (workspace.spec.residency === "Archived" && this.options.inventoryStore) {
          entries.push(
            ...(await readArchivedInventory(
              this.options.inventoryStore,
              workspace,
              message,
              undefined,
              this.options.agentRouting,
            )),
          );
          continue;
        }
        if (!workspace.status) continue;
        const start = entries.length;
        try {
          if (workspace.spec.residency !== "Running" || workspace.status.phase !== "Ready")
            throw new Error("Workspace backend unavailable");
          const connection = await this.connection(workspace);
          const filter = message.filter
            ? object(translate(message.filter, workspace, connection.localId, "in"))
            : undefined;
          if (filter) delete filter.projectKeys;
          let cursor: string | undefined;
          do {
            const request = SessionInboundMessageSchema.parse({
              ...message,
              requestId: randomUUID(),
              filter,
              sync: undefined,
              page: { limit: 200, ...(cursor ? { cursor } : {}) },
            });
            const reply = await connection.backend.request(request);
            if (
              reply.type !== "fetch_agents_response" &&
              reply.type !== "fetch_agent_history_response"
            )
              throw new Error("Unexpected agent inventory response");
            const projected = await connection.enqueue(async () => {
              const translated = translate(
                reply.payload.entries,
                workspace,
                connection.localId,
                "out",
              );
              return this.options.agentRouting
                ? this.options.agentRouting.project(translated, workspace)
                : translated;
            });
            if (!Array.isArray(projected)) throw new Error("Invalid projected agent page");
            entries.push(
              ...projected.map((entry) => {
                const row = object(entry);
                return {
                  ...row,
                  agent: AgentSnapshotPayloadSchema.parse(row.agent),
                  syncSeq: this.options.directory.next(),
                };
              }),
            );
            cursor = reply.payload.pageInfo.hasMore
              ? (reply.payload.pageInfo.nextCursor ?? undefined)
              : undefined;
          } while (cursor);
        } catch (error) {
          entries.splice(start);
          if (!this.options.inventoryStore) throw error;
          entries.push(
            ...(await readArchivedInventory(
              this.options.inventoryStore,
              workspace,
              message,
              workspace.spec.residency === "Suspended" ? "suspended" : "stale",
              this.options.agentRouting,
            )),
          );
        }
      }
      sortAgents(entries, message.sort);
      this.options.emit({
        type:
          message.type === "fetch_agents_request"
            ? "fetch_agents_response"
            : "fetch_agent_history_response",
        payload: {
          requestId,
          ...this.pages.read(pageKey, message.page, entries),
          ...(message.type === "fetch_agents_request"
            ? {
                subscriptionId: message.subscribe?.subscriptionId ?? null,
                sync: this.options.directory.snapshot(message.sync?.generation),
              }
            : {}),
        },
      });
      return;
    }
    if (message.type === "directory_suggestions_request" && !("cwd" in message && message.cwd)) {
      this.options.emit({
        type: "directory_suggestions_response",
        payload: {
          requestId,
          directories: projects.map((p) => projectPath(p.metadata.name)),
          entries: projects.map((p) => ({ path: projectPath(p.metadata.name), kind: "directory" })),
          error: null,
        },
      });
      return;
    }
    if (
      await this.labels?.handle(
        message,
        this.options.principal ?? { kind: "owner" },
        this.options.emit,
      )
    )
      return;
    if (message.type === "agent.timeline.set_subscription.request") {
      const grouped = new Map<string, string[]>();
      for (const id of message.agentIds) {
        const resolved = this.options.agentRouting
          ? await this.options.agentRouting.resolveAgent(id, workspaces)
          : undefined;
        const route = resolved
          ? { workspaceId: resolved.workspace.metadata.name, backendId: resolved.backendAgentId }
          : parseScopedId(id);
        grouped.set(route.workspaceId, [
          ...(grouped.get(route.workspaceId) ?? []),
          route.backendId,
        ]);
      }
      for (const id of new Set([...this.connections.keys(), ...grouped.keys()])) {
        const workspace = active.find((w) => w.metadata.name === id);
        if (!workspace) continue;
        const connection = await this.connection(workspace);
        if (this.options.agentRouting) {
          for (const agentId of grouped.get(id) ?? [])
            await this.options.agentRouting.resolveAgent(agentId, [workspace]);
        }
        const current = (await this.records()).workspaces.find((row) => row.metadata.name === id);
        if (
          !current ||
          current.metadata.uid !== workspace.metadata.uid ||
          current.spec.residency !== "Running" ||
          current.status?.phase !== "Ready"
        )
          throw new Error("Timeline workspace is stopped or replaced; reconnect before acting");
        await connection.backend.request({
          type: message.type,
          requestId: randomUUID(),
          agentIds: grouped.get(id) ?? [],
        });
      }
      this.options.emit({
        type: "agent.timeline.set_subscription.response",
        payload: { requestId, agentIds: message.agentIds },
      });
      return;
    }
    if (
      message.type === "fetch_agent_request" &&
      (message.agentId.includes("~") ||
        (this.options.agentRouting && z.guid().safeParse(message.agentId).success))
    ) {
      const resolved = this.options.agentRouting
        ? await this.options.agentRouting.resolveAgent(message.agentId, workspaces)
        : undefined;
      const route = resolved
        ? { workspaceId: resolved.workspace.metadata.name, backendId: resolved.backendAgentId }
        : parseScopedId(message.agentId);
      const workspace = workspaces.find((row) => row.metadata.name === route.workspaceId);
      if (
        workspace &&
        this.options.inventoryStore &&
        (workspace.spec.residency !== "Running" || workspace.status?.phase !== "Ready")
      ) {
        const entry = (
          await readArchivedInventory(
            this.options.inventoryStore,
            workspace,
            undefined,
            workspace.spec.residency === "Archived" ? "archived" : "suspended",
            this.options.agentRouting,
          )
        ).find(
          (row) => row.agent.id === (this.options.agentRouting ? route.backendId : message.agentId),
        );
        this.options.emit({
          type: "fetch_agent_response",
          payload: { requestId, agent: entry?.agent ?? null, project: entry?.project, error: null },
        });
        return;
      }
      if (workspace) {
        await this.forward(message, workspace);
        return;
      }
    }
    if (
      typeof record.agentId === "string" &&
      !record.agentId.includes("~") &&
      (!this.options.agentRouting || !z.guid().safeParse(record.agentId).success) &&
      message.type !== "agent.create.request"
    ) {
      const query = record.agentId;
      const matches: Extract<SessionOutboundMessage, { type: "fetch_agent_response" }>[] = [];
      for (const workspace of workspaces) {
        if (workspace.spec.residency !== "Running" && this.options.inventoryStore) {
          for (const entry of await readArchivedInventory(
            this.options.inventoryStore,
            workspace,
            undefined,
            workspace.spec.residency === "Archived" ? "archived" : "suspended",
            this.options.agentRouting,
          )) {
            const id = this.options.agentRouting
              ? entry.agent.id
              : parseScopedId(entry.agent.id).backendId;
            if (id.startsWith(query) || entry.agent.title?.toLowerCase() === query.toLowerCase())
              matches.push({
                type: "fetch_agent_response",
                payload: { requestId, agent: entry.agent, project: entry.project, error: null },
              });
          }
          continue;
        }
        if (!workspace.status) continue;
        const connection = await this.connection(workspace);
        const reply = await connection.backend.request({
          type: "fetch_agent_request",
          requestId: randomUUID(),
          agentId: query,
        });
        if (reply.type !== "fetch_agent_response")
          throw new Error("Unexpected agent lookup response");
        if (reply.payload.agent) {
          const translated = SessionOutboundMessageSchema.parse(
            await this.project(reply, workspace, connection.localId),
          );
          if (translated.type === "fetch_agent_response")
            matches.push({ ...translated, payload: { ...translated.payload, requestId } });
        }
      }
      if (matches.length > 1)
        throw new Error(
          "Agent prefix or title is ambiguous across workspaces; use the full scoped ID",
        );
      if (message.type === "fetch_agent_request") {
        this.options.emit(
          matches[0] ?? {
            type: "fetch_agent_response",
            payload: { requestId, agent: null, error: null },
          },
        );
        return;
      }
      const matched = matches[0]?.payload.agent;
      if (!matched) throw new Error("Agent not found");
      record.agentId = matched.id;
    }
    if (message.type === "client_heartbeat" || message.type === "ping") return;
    if (message.type === "create_agent_request" || message.type === "agent.create.request") {
      if (message.worktree || message.worktreeName || message.git)
        throw new Error("Create workspaces through the cluster workspace operation first");
    }
    if (message.type === "checkout_status_request" && message.cwd.startsWith("/projects/")) {
      const project = projectForCatalogPath(message.cwd, projects);
      if (!project) throw new Error("Project checkout is not authorized or configured");
      const catalog = this.options.providerCatalog;
      if (!catalog) throw new Error("Project checkout discovery is unavailable");
      const status = await this.scopedCheckoutStatus(catalog, project);
      // A timed-out checkout RPC is not allowed to emit a late success. The
      // shared catalog probe continues and can satisfy a subsequent request.
      if (checkoutDeadline !== undefined && Date.now() >= checkoutDeadline)
        throw new Error("Project checkout discovery timed out; retry shortly");
      if (this.closed) return;
      this.options.emit({
        type: "checkout_status_response",
        payload: {
          ...status,
          cwd: projectPath(project.metadata.name),
          requestId: message.requestId,
        },
      });
      return;
    }
    if (
      (message.type === "branch_suggestions_request" ||
        message.type === "validate_branch_request") &&
      message.cwd.startsWith("/projects/")
    ) {
      const project = projectForCatalogPath(message.cwd, projects);
      if (!project) throw new Error("Project ref source is not authorized or configured");
      const query: ProjectRefQuery =
        message.type === "branch_suggestions_request"
          ? { mode: "suggest", query: message.query, limit: message.limit }
          : { mode: "validate", branchName: message.branchName };
      const result = await this.scopedProjectRefs(project, query);
      if (checkoutDeadline !== undefined && Date.now() >= checkoutDeadline)
        throw new Error("Project ref inspection timed out; retry shortly");
      if (this.closed) return;
      if (result.mode === "suggest") {
        this.options.emit({
          type: "branch_suggestions_response",
          payload: {
            requestId: message.requestId,
            branches: result.refs,
            branchDetails: result.refs.map((name) => ({
              name,
              committerDate: 0,
              hasLocal: false,
              hasRemote: true,
            })),
            error: null,
          },
        });
      } else {
        this.options.emit({
          type: "validate_branch_response",
          payload: {
            requestId: message.requestId,
            exists: result.exists,
            resolvedRef:
              result.exists && query.mode === "validate"
                ? `origin/${normalizeProjectBranchName(query.branchName)}`
                : null,
            isRemote: result.exists,
            error: result.valid ? null : "Invalid Git branch name",
          },
        });
      }
      return;
    }
    if (providerRequests.has(message.type)) {
      if (typeof record.cwd === "string" && record.cwd.startsWith("/projects/")) {
        const project = projectForCatalogPath(record.cwd, projects);
        if (!project) throw new Error("Provider catalog project is not authorized or configured");
        const catalog = this.options.providerCatalog;
        if (!catalog) throw new Error("Project provider discovery is unavailable");
        if (!project.metadata.uid) throw new Error("Provider catalog Project UID is unavailable");
        const previousWatch = this.providerWatches.get(project.metadata.name);
        if (previousWatch?.projectUid !== project.metadata.uid) {
          previousWatch?.release();
          const projectUid = project.metadata.uid;
          const release = catalog.watch(project.metadata.name, () => {
            void (async () => {
              if (this.closed) return;
              const current = projectForCatalogPath(
                projectPath(project.metadata.name),
                (await this.records()).projects,
              );
              if (!current || current.metadata.uid !== projectUid) return;
              const entries = await this.scopedProviderSnapshot(catalog, current);
              if (!this.closed)
                this.options.emit({
                  type: "providers_snapshot_update",
                  payload: {
                    cwd: projectPath(current.metadata.name),
                    entries,
                    generatedAt: new Date().toISOString(),
                  },
                });
            })().catch(() => {});
          });
          this.providerWatches.set(project.metadata.name, { projectUid, release });
        }
        if (message.type === "get_providers_snapshot_request") {
          const entries = await this.scopedProviderSnapshot(catalog, project);
          this.options.emit({
            type: "get_providers_snapshot_response",
            payload: {
              requestId,
              cwd: projectPath(project.metadata.name),
              entries,
              generatedAt: new Date().toISOString(),
            },
          });
          return;
        }
        if (message.type === "refresh_providers_snapshot_request") {
          await this.scopedProviderSnapshot(catalog, project, true);
          this.options.emit({
            type: "refresh_providers_snapshot_response",
            payload: { requestId, acknowledged: true },
          });
          return;
        }
        throw new Error("Project-scoped provider operation requires a workspace");
      }
      const workspace =
        typeof record.cwd === "string"
          ? selectWorkspace(record, active)
          : active.find((w) => w.status?.phase === "Ready");
      if (!workspace) {
        if (message.type === "get_providers_snapshot_request") {
          this.options.emit({
            type: "get_providers_snapshot_response",
            payload: { requestId, entries: [], generatedAt: new Date().toISOString() },
          });
          return;
        }
        if (message.type === "refresh_providers_snapshot_request") {
          this.options.emit({
            type: "refresh_providers_snapshot_response",
            payload: { requestId, acknowledged: true },
          });
          return;
        }
        throw new Error("Create a workspace and wait for readiness before querying providers");
      }
      await this.forward(message, workspace);
      return;
    }
    if (
      !forwarded.has(message.type) &&
      !message.type.startsWith("checkout_") &&
      !message.type.startsWith("checkout.") &&
      !message.type.startsWith("fs.")
    ) {
      throw new Error(`Operation ${message.type} is not supported by this POC`);
    }
    if (
      typeof record.subscriptionId === "string" &&
      !record.cwd &&
      this.subscriptions.has(record.subscriptionId)
    ) {
      record.workspaceId = this.subscriptions.get(record.subscriptionId);
    }
    const routed = this.options.agentRouting
      ? SessionInboundMessageSchema.parse(
          await this.options.agentRouting.route(message, workspaces),
        )
      : message;
    const workspace = selectWorkspace(object(routed), active);
    await this.forward(routed, workspace);
  }

  private async forward(message: SessionInboundMessage, workspace: Workspace) {
    const validate = async () => {
      const { workspaces } = await this.records();
      const current = workspaces.find((row) => row.metadata.name === workspace.metadata.name);
      if (
        !current ||
        current.metadata.uid !== workspace.metadata.uid ||
        current.metadata.deletionTimestamp ||
        current.spec.residency !== "Running" ||
        current.status?.phase !== "Ready"
      )
        throw new Error("Workspace is stopped or replaced; reconnect before acting");
    };
    await validate();
    const connection = await this.connection(workspace);
    const routed = this.options.agentRouting
      ? SessionInboundMessageSchema.parse(
          await this.options.agentRouting.route(message, [workspace]),
        )
      : message;
    if (message.type === "file_download_token_request") {
      const root = workspacePath(workspace.metadata.name);
      const path = posix.normalize(message.path);
      if (!posix.isAbsolute(message.path) || (path !== root && !path.startsWith(`${root}/`)))
        throw new Error("Download path is outside the selected workspace");
      if (!this.options.downloadHandles) throw new Error("Gateway download routing is unavailable");
    }
    let input = SessionInboundMessageSchema.parse(
      translate(routed, workspace, connection.localId, "in"),
    );
    if (input.type === "send_agent_message_request")
      input = await this.uploads.replace(input, connection.backend, validate);
    await validate();
    if (this.options.agentRouting) {
      // A UUID can be quarantined by another session while connect/upload waits.
      await this.options.agentRouting.route(routed, [workspace]);
    }
    // The final durable identity read can await Kubernetes. Recheck principal and
    // exact workspace state after it, immediately before sending the mutation.
    await validate();
    const record = object(message);
    if (typeof record.subscriptionId === "string")
      this.subscriptions.set(record.subscriptionId, workspace.metadata.name);
    if (
      input.type === "agent_permission_response" ||
      !("requestId" in input) ||
      typeof input.requestId !== "string"
    ) {
      // Here requestId identifies a permission prompt; upstream sends no RPC ack.
      connection.backend.send(input);
      return;
    }
    if (input.type === "file_explorer_request" && input.acceptBinary) {
      // Binary downloads complete in the client's upstream codec, without a JSON RPC response.
      connection.backend.send(input);
      return;
    }
    const reply = await connection.backend.request(input);
    await connection.enqueue(async () => {
      const result = object(await this.project(reply, workspace, connection.localId));
      if (reply.type === "file_download_token_response" && reply.payload.token) {
        const handles = this.options.downloadHandles;
        if (!handles) throw new Error("Gateway download routing is unavailable");
        object(result.payload).token = handles.issue({
          workspace,
          principal: this.options.principal ?? { kind: "owner" },
          backendToken: reply.payload.token,
          mimeType: reply.payload.mimeType,
          fileName: reply.payload.fileName,
          size: reply.payload.size,
        });
      }
      if (reply.type === "subscribe_terminal_response" && "slot" in reply.payload) {
        object(result.payload).slot = this.slots.outward(
          workspace.metadata.name,
          reply.payload.slot,
        );
      }
      this.options.emit(result);
    });
  }

  async binary(data: Uint8Array) {
    const { workspaces } = await this.records();
    const terminal = decodeTerminalStreamFrame(data);
    if (terminal) {
      const route = this.slots.inward(terminal.slot);
      const connection = await this.connections.get(route.workspaceId);
      if (!connection) throw new Error("Terminal workspace is disconnected");
      const current = workspaces.find((row) => row.metadata.name === route.workspaceId);
      if (
        !current ||
        current.metadata.uid !== connection.workspace.metadata.uid ||
        current.spec.residency !== "Running" ||
        current.status?.phase !== "Ready"
      )
        throw new Error("Terminal workspace is stopped or replaced");
      connection.backend.binary(
        encodeTerminalStreamFrame({ ...terminal, slot: route.backendSlot }),
      );
      return;
    }
    const file = decodeFileTransferFrame(data);
    if (file && this.uploads.binary(data)) return;
    throw new Error("Unknown binary transfer");
  }

  async refreshDirectory() {
    if (this.closed || this.refreshing) return;
    this.refreshing = true;
    try {
      const { workspaces, projects } = await this.records();
      const active = workspaces.filter((w) => w.spec.residency !== "Archived");
      for (const [id, entry] of this.connections) {
        const connected = await entry.catch(() => undefined);
        const current = active.find((workspace) => workspace.metadata.name === id);
        if (
          !current ||
          !connected ||
          current.spec.residency !== "Running" ||
          current.status?.phase !== "Ready" ||
          connected.workspace.metadata.uid !== current.metadata.uid
        ) {
          this.connections.delete(id);
          this.workspaceRuntime.delete(id);
          if (!connected) continue;
          connected.retire();
          await connected.backend.close();
        }
      }
      if (!this.watchingWorkspaces) return;
      const labels = await this.labels?.workspaceLabelsMany(active);
      for (const workspace of active) {
        if (workspace.spec.residency === "Running" && workspace.status?.phase === "Ready")
          await this.connection(workspace);
        const descriptor = workspaceDescriptor(
          workspace,
          this.projectFor(workspace, projects),
          workspace.spec.residency === "Running" && workspace.status?.phase === "Ready"
            ? this.workspaceRuntime.get(workspace.metadata.name)
            : undefined,
        );
        descriptor.labels = labels?.get(workspace.metadata.name) ?? [];
        const serialized = JSON.stringify(descriptor);
        if (this.workspaceProjections.get(workspace.metadata.name) === serialized) continue;
        this.workspaceProjections.set(workspace.metadata.name, serialized);
        if (!this.closed)
          this.options.emit({
            type: "workspace_update",
            payload: {
              kind: "upsert",
              workspace: descriptor,
              generation: this.options.directory.id,
              seq: this.options.directory.next(),
            },
          });
      }
      for (const id of this.workspaceProjections.keys())
        if (!active.some((w) => w.metadata.name === id)) {
          this.workspaceProjections.delete(id);
          this.workspaceRuntime.delete(id);
          if (!this.closed)
            this.options.emit({
              type: "workspace_update",
              payload: {
                kind: "remove",
                id,
                generation: this.options.directory.id,
                seq: this.options.directory.next(),
              },
            });
        }
    } catch (error) {
      const connected = await Promise.allSettled([...this.connections.values()]);
      this.connections.clear();
      for (const result of connected)
        if (result.status === "fulfilled") {
          result.value.retire();
          await result.value.backend.close().catch(() => {});
        }
      throw error;
    } finally {
      this.refreshing = false;
    }
  }

  async close() {
    this.closed = true;
    for (const watch of this.providerWatches.values()) watch.release();
    this.providerWatches.clear();
    this.labels?.releaseEmitter(this.options.emit);
    this.options.operations?.close?.(this.options.emit);
    await Promise.allSettled(
      [...this.connections.values()].map(async (entry) => {
        const connection = await entry;
        connection.retire();
        await connection.backend.close();
      }),
    );
    this.connections.clear();
    this.workspaceRuntime.clear();
    this.uploads.clear();
    this.subscriptions.clear();
  }

  invalidateAgentDirectory() {
    this.options.disconnect();
  }
}
