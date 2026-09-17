import { randomUUID } from "node:crypto";
import {
  decodeFileTransferFrame,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  type SessionInboundMessage,
  SessionInboundMessageSchema,
  type SessionOutboundMessage,
  type WorkspaceDescriptorPayload,
  type WSHelloMessage,
} from "@getpaseo/protocol/messages";
import { resourceName } from "../controller/resources.js";
import {
  API_VERSION,
  type Project,
  parseScopedId,
  projectPath,
  type Workspace,
  workspacePath,
} from "../domain.js";
import type { Store } from "../kubernetes/store.js";
import { type Backend, PaseoBackend } from "./backend.js";
import { type DirectoryGeneration, projectDescriptor, workspaceDescriptor } from "./catalog.js";
import { type JsonObject, object, selectWorkspace, TerminalSlots, translate } from "./routing.js";

const forwarded = new Set([
  "create_agent_request",
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
  "provider_usage_list_request",
]);

export interface SessionOptions {
  store: Store;
  namespace: string;
  backendPassword: string;
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
    Promise<{ backend: Backend; workspace: Workspace; localId: string }>
  >();
  private readonly slots = new TerminalSlots();
  private readonly uploads = new Map<string, string>();
  private readonly subscriptions = new Map<string, string>();
  private closed = false;
  private watchingWorkspaces = false;
  private refreshing = false;
  private readonly workspaceRuntime = new Map<string, WorkspaceDescriptorPayload>();
  private readonly workspaceProjections = new Map<string, string>();
  constructor(private readonly options: SessionOptions) {}

  private async connection(workspace: Workspace) {
    const id = workspace.metadata.name;
    const previous = this.connections.get(id);
    if (previous) return previous;
    if (workspace.spec.residency !== "Running" || workspace.status?.phase !== "Ready") {
      throw new Error(
        `Workspace ${id} is ${workspace.status?.phase ?? "Pending"}; inventory is unavailable, not deleted`,
      );
    }
    const promise = (async () => {
      let localId = workspace.status?.backendWorkspaceId ?? "";
      const onMessage = (message: SessionOutboundMessage) => {
        if (this.closed) return;
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
        const translated = object(translate(message, workspace, localId, "out"));
        if (message.type === "agent_update") {
          const payload = object(translated.payload);
          payload.generation = this.options.directory.id;
          payload.seq = this.options.directory.next();
        }
        this.options.emit(translated);
      };
      const onBinary = (data: Uint8Array) => {
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
          `ws://${resourceName(workspace)}.${this.options.namespace}.svc:6767/ws`,
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
          subscribe: { subscriptionId: randomUUID() },
          page: { limit: 200 },
        });
        if (snapshot.type !== "fetch_workspaces_response")
          throw new Error("Workspace subscription failed");
        const runtime = snapshot.payload.entries.find((entry) => entry.id === localId);
        if (runtime) this.workspaceRuntime.set(id, runtime);
        return { backend, workspace, localId };
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
    return { projects, workspaces: workspaces.filter((w) => !w.metadata.deletionTimestamp) };
  }

  private projectFor(workspace: Workspace, projects: Project[]) {
    const project = projects.find((p) => p.metadata.name === workspace.spec.projectRef);
    if (!project) throw new Error("Workspace project no longer exists");
    return project;
  }

  async handle(message: SessionInboundMessage) {
    if (this.closed) return;
    const record = object(message);
    const requestId = typeof record.requestId === "string" ? record.requestId : undefined;
    try {
      await this.dispatch(message);
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
    }
  }

  private async dispatch(message: SessionInboundMessage) {
    const record = object(message);
    const requestId = typeof record.requestId === "string" ? record.requestId : "";
    const { projects, workspaces } = await this.records();
    const active = workspaces.filter((w) => w.spec.residency !== "Archived");
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
      if (message.page?.cursor)
        throw new Error("Workspace cursor expired; request a full snapshot");
      await Promise.all(
        active
          .filter((w) => w.spec.residency === "Running" && w.status?.phase === "Ready")
          .map((w) => this.connection(w)),
      );
      let rows = active
        .filter((w) => !message.filter?.projectId || w.spec.projectRef === message.filter.projectId)
        .map((w) => ({
          ...workspaceDescriptor(
            w,
            this.projectFor(w, projects),
            this.workspaceRuntime.get(w.metadata.name),
          ),
          syncSeq: this.options.directory.next(),
        }));
      if (message.filter?.query) {
        const q = message.filter.query.toLowerCase();
        rows = rows.filter((w) => w.name.toLowerCase().includes(q));
      }
      if (rows.length > (message.page?.limit ?? 200))
        throw new Error("POC workspace page limit exceeded; narrow the filter");
      this.options.emit({
        type: "fetch_workspaces_response",
        payload: {
          requestId,
          entries: rows,
          emptyProjects: projects
            .filter((p) => !active.some((w) => w.spec.projectRef === p.metadata.name))
            .map(projectDescriptor),
          subscriptionId: message.subscribe?.subscriptionId ?? null,
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
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
      if (message.page?.cursor) throw new Error("Agent cursor expired; request a full snapshot");
      const entries: unknown[] = [];
      for (const workspace of active.filter(
        (w) =>
          !message.filter?.projectKeys?.length ||
          message.filter.projectKeys.includes(w.spec.projectRef),
      )) {
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
          entries.push(
            ...reply.payload.entries.map((entry) => ({
              ...object(translate(entry, workspace, connection.localId, "out")),
              syncSeq: this.options.directory.next(),
            })),
          );
          cursor = reply.payload.pageInfo.hasMore
            ? (reply.payload.pageInfo.nextCursor ?? undefined)
            : undefined;
        } while (cursor);
      }
      if (entries.length > (message.page?.limit ?? 200))
        throw new Error("POC agent page limit exceeded; narrow the filter");
      this.options.emit({
        type:
          message.type === "fetch_agents_request"
            ? "fetch_agents_response"
            : "fetch_agent_history_response",
        payload: {
          requestId,
          entries,
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
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
    if (message.type === "workspace.label.list.request") {
      this.options.emit({
        type: "workspace.label.list.response",
        payload: { requestId, labels: [], sync: this.options.directory.snapshot() },
      });
      return;
    }
    if (message.type === "agent.timeline.set_subscription.request") {
      const grouped = new Map<string, string[]>();
      for (const id of message.agentIds) {
        const route = parseScopedId(id);
        grouped.set(route.workspaceId, [
          ...(grouped.get(route.workspaceId) ?? []),
          route.backendId,
        ]);
      }
      for (const id of new Set([...this.connections.keys(), ...grouped.keys()])) {
        const workspace = active.find((w) => w.metadata.name === id);
        if (!workspace) continue;
        const connection = await this.connection(workspace);
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
    if (message.type === "client_heartbeat" || message.type === "ping") return;
    if (message.type === "create_agent_request") {
      if (message.worktree || message.worktreeName || message.git)
        throw new Error("Create workspaces through the cluster workspace operation first");
      if (message.config.provider !== "claude")
        throw new Error("This POC supports Claude Code only");
    }
    if (providerRequests.has(message.type)) {
      const workspace =
        typeof record.cwd === "string"
          ? selectWorkspace(record, active)
          : active.find((w) => w.status?.phase === "Ready");
      if (!workspace) {
        if (
          message.type === "get_providers_snapshot_request" ||
          message.type === "refresh_providers_snapshot_request"
        ) {
          this.options.emit({
            type:
              message.type === "get_providers_snapshot_request"
                ? "get_providers_snapshot_response"
                : "refresh_providers_snapshot_response",
            payload: { requestId, entries: [], generatedAt: new Date().toISOString() },
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
    const workspace = selectWorkspace(record, active);
    await this.forward(message, workspace);
  }

  private async forward(message: SessionInboundMessage, workspace: Workspace) {
    const connection = await this.connection(workspace);
    const input = SessionInboundMessageSchema.parse(
      translate(message, workspace, connection.localId, "in"),
    );
    const record = object(message);
    if (message.type === "file.upload.request" && typeof record.requestId === "string")
      this.uploads.set(record.requestId, workspace.metadata.name);
    if (typeof record.subscriptionId === "string")
      this.subscriptions.set(record.subscriptionId, workspace.metadata.name);
    if (!("requestId" in input) || typeof input.requestId !== "string") {
      connection.backend.send(input);
      return;
    }
    if (input.type === "file_explorer_request" && input.acceptBinary) {
      // Binary downloads complete in the client's upstream codec, without a JSON RPC response.
      connection.backend.send(input);
      return;
    }
    const reply = await connection.backend.request(input);
    const result = object(translate(reply, workspace, connection.localId, "out"));
    if (reply.type === "subscribe_terminal_response" && "slot" in reply.payload) {
      object(result.payload).slot = this.slots.outward(workspace.metadata.name, reply.payload.slot);
    }
    this.options.emit(result);
  }

  async binary(data: Uint8Array) {
    const terminal = decodeTerminalStreamFrame(data);
    if (terminal) {
      const route = this.slots.inward(terminal.slot);
      const connection = await this.connections.get(route.workspaceId);
      if (!connection) throw new Error("Terminal workspace is disconnected");
      connection.backend.binary(
        encodeTerminalStreamFrame({ ...terminal, slot: route.backendSlot }),
      );
      return;
    }
    const file = decodeFileTransferFrame(data);
    const route = file && this.uploads.get(file.requestId);
    const connection = route ? await this.connections.get(route) : undefined;
    if (!connection) throw new Error("Unknown binary transfer");
    connection.backend.binary(data);
    if (file?.opcode === 0x12) this.uploads.delete(file.requestId);
  }

  async refreshDirectory() {
    if (this.closed || this.refreshing || !this.watchingWorkspaces) return;
    this.refreshing = true;
    try {
      const { workspaces, projects } = await this.records();
      const active = workspaces.filter((w) => w.spec.residency !== "Archived");
      for (const workspace of active) {
        if (workspace.spec.residency === "Running" && workspace.status?.phase === "Ready")
          await this.connection(workspace);
        const descriptor = workspaceDescriptor(
          workspace,
          this.projectFor(workspace, projects),
          this.workspaceRuntime.get(workspace.metadata.name),
        );
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
    } finally {
      this.refreshing = false;
    }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled(
      [...this.connections.values()].map(async (entry) => (await entry).backend.close()),
    );
    this.connections.clear();
    this.workspaceRuntime.clear();
    this.uploads.clear();
    this.subscriptions.clear();
  }
}
