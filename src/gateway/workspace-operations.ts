import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgentSnapshotPayloadSchema,
  CreationSnapshotSchema,
  type SessionInboundMessage,
  SessionInboundMessageSchema,
  type SessionOutboundMessage,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import type { ScheduleRun, StoredSchedule } from "@getpaseo/protocol/schedule/types";
import type { WorkspaceAdmission } from "../controller/admission.js";
import { resourceName } from "../controller/resources.js";
import {
  API_GROUP,
  API_VERSION,
  parseScopedId,
  projectPath,
  type Workspace,
  WorkspaceSchema,
  workspacePath,
} from "../domain.js";
import type { ControlRecord, RecordStore } from "../kubernetes/records.js";
import { type Store, statusCode } from "../kubernetes/store.js";
import {
  archiveAgentInventory,
  readArchivedInventory,
  retainedAgentMetadata,
} from "./agent-inventory.js";
import type { AgentRouting } from "./agent-routing.js";
import {
  authorizeProject,
  authorizeWorkspace,
  type GatewayPrincipal,
  principalIsActive,
} from "./auth.js";
import { type Backend, PaseoBackend } from "./backend.js";
import { workspaceDescriptor } from "./catalog.js";
import { CreationJournal, type CreationProgress } from "./creation-journal.js";
import { object, translate } from "./routing.js";
import { ScheduleDispatchRejected } from "./schedules.js";
import type { UploadStaging } from "./uploads.js";

type CreateWorkspace = Extract<SessionInboundMessage, { type: "workspace.create.request" }>;
type CreateAgent = Extract<
  SessionInboundMessage,
  { type: "create_agent_request" | "agent.create.request" }
>;
type Emit = (message: SessionOutboundMessage | Record<string, unknown>) => void;
interface Receipt {
  fingerprint: string;
  workspaceId: string;
  workspaceUid: string;
  response?: SessionOutboundMessage;
}
export interface WorkspaceOperationsOptions {
  store: Store & RecordStore;
  namespace: string;
  backendPassword: string;
  backendSecure?: boolean;
  agentRouting?: AgentRouting;
  admission: WorkspaceAdmission;
  readyTimeoutMs?: number;
  pollMs?: number;
  scheduleRetentionSeconds?: number;
  revokedTokenIds?: ReadonlySet<string>;
  backendFactory?: (workspace: Workspace, emit: Emit) => Backend;
}
const owner: GatewayPrincipal = { kind: "owner" };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function retainedCreationResponse(response: SessionOutboundMessage): SessionOutboundMessage {
  const copy = object(structuredClone(response));
  const payload = object(copy.payload);
  if (payload.agent)
    payload.agent = retainedAgentMetadata(AgentSnapshotPayloadSchema.parse(payload.agent));
  if (payload.creation) {
    const creation = object(payload.creation);
    if (creation.agent)
      creation.agent = retainedAgentMetadata(AgentSnapshotPayloadSchema.parse(creation.agent));
    delete creation.workspace;
  }
  return SessionOutboundMessageSchema.parse(copy);
}

/** Cluster-owned creation and archive operations. A durable claim precedes each keyed
 * agent mutation; a lost acknowledgment is never silently replayed after replacement.
 */
export class WorkspaceOperations {
  readonly creationLifecycle = true;
  private readonly journal: CreationJournal;
  private backfillInFlight?: Promise<void>;
  constructor(private readonly options: WorkspaceOperationsOptions) {
    this.journal = new CreationJournal(
      options.store,
      async (principal, identity) => {
        const { workspaces } = await this.records(principal);
        if (identity) {
          const row = workspaces.find(
            (row) =>
              row.metadata.name === identity.workspaceId &&
              row.metadata.uid === identity.workspaceUid,
          );
          if (!row || !authorizeWorkspace(principal, row))
            throw new Error("Creation workspace access denied");
        }
      },
      async (snapshot, principal, identity) => {
        if (!options.agentRouting || (!snapshot.agent && !snapshot.agentId)) return snapshot;
        if (!identity) throw new Error("Creation identity has no UID-bound workspace");
        const { workspaces } = await this.records(principal);
        const workspace = workspaces.find(
          (row) =>
            row.metadata.name === identity.workspaceId &&
            row.metadata.uid === identity.workspaceUid &&
            authorizeWorkspace(principal, row),
        );
        if (!workspace) throw new Error("Creation workspace access denied");
        return CreationSnapshotSchema.parse(
          await options.agentRouting.project(snapshot, workspace),
        );
      },
    );
  }

  close(emit: Emit) {
    this.journal.close(emit);
  }

  /** Before honoring a caller-chosen GUID, claim every discoverable pre-upgrade
   * agent from its UID-bound source. An unavailable source blocks that create.
   * Gateway-generated random GUIDs do not require this global scan.
   */
  async backfillAgentIdentities() {
    const agentRouting = this.options.agentRouting;
    if (!agentRouting) return;
    if (this.backfillInFlight) return this.backfillInFlight;
    const task = (async () => {
      const workspaces = await this.options.store.workspaces();
      for (const workspace of workspaces) {
        if (!workspace.metadata.uid || workspace.metadata.deletionTimestamp)
          throw new Error("Agent identity backfill is incomplete");
        if (workspace.status?.storageDeletedAt)
          throw new Error("Agent identity backfill cannot verify purged workspace history");
        if (workspace.spec.residency === "Running" && workspace.status?.phase !== "Ready")
          throw new Error("Agent identity backfill cannot verify a restarting workspace");
        if (workspace.spec.residency !== "Running") {
          const retained = await readArchivedInventory(this.options.store, workspace);
          for (const entry of retained)
            await agentRouting.claim(workspace, parseScopedId(entry.agent.id).backendId);
          continue;
        }
        const { backend } = await this.backend(workspace, () => {});
        try {
          let cursor: string | undefined;
          const seenCursors = new Set<string>();
          do {
            const response = await backend.request({
              type: "fetch_agents_request",
              requestId: randomUUID(),
              filter: { includeArchived: true },
              page: { limit: 200, ...(cursor ? { cursor } : {}) },
            });
            if (response.type !== "fetch_agents_response")
              throw new Error("Agent identity backfill returned an invalid inventory");
            for (const entry of response.payload.entries)
              await agentRouting.claim(workspace, entry.agent.id);
            cursor = response.payload.pageInfo.hasMore
              ? (response.payload.pageInfo.nextCursor ?? undefined)
              : undefined;
            if (response.payload.pageInfo.hasMore && !cursor)
              throw new Error("Agent identity backfill inventory lacks a continuation cursor");
            if (cursor) {
              if (seenCursors.has(cursor) || seenCursors.size >= 100)
                throw new Error("Agent identity backfill inventory exceeds its page limit");
              seenCursors.add(cursor);
            }
          } while (cursor);
        } finally {
          await backend.close();
        }
      }
    })();
    this.backfillInFlight = task;
    try {
      await task;
    } finally {
      this.backfillInFlight = undefined;
    }
  }

  private async records(principal: GatewayPrincipal) {
    const [projects, workspaces] = await Promise.all([
      this.options.store.projects(),
      this.options.store.workspaces(),
    ]);
    if (!principalIsActive(principal, workspaces))
      throw new Error("Workspace credential expired or revoked");
    return { projects, workspaces };
  }

  async createWorkspace(
    message: CreateWorkspace,
    principal: GatewayPrincipal = owner,
    retentionPolicy?: Workspace["spec"]["retentionPolicy"],
  ) {
    const { projects, workspaces } = await this.records(principal);
    const source = message.source;
    const cwd = source.kind === "directory" ? source.path : source.cwd;
    const sourceWorkspace = workspaces.find((row) => cwd === workspacePath(row.metadata.name));
    const projectId =
      source.projectId ??
      sourceWorkspace?.spec.projectRef ??
      projects.find((row) => projectPath(row.metadata.name) === cwd)?.metadata.name;
    const project = projects.find((row) => row.metadata.name === projectId);
    if (
      !project ||
      !authorizeProject(principal, project.metadata.name) ||
      (principal.kind === "workspace" &&
        !principal.credentialProfiles.includes(project.spec.credentialProfile))
    )
      throw new Error("Select an authorized configured Kubernetes project");
    if (sourceWorkspace && !authorizeWorkspace(principal, sourceWorkspace))
      throw new Error("Source workspace access denied");
    if (message.workspaceId)
      throw new Error("Caller-assigned workspace IDs are not supported; use an idempotency key");
    if (
      source.kind === "worktree" &&
      source.checkoutSource &&
      source.checkoutSource.forge &&
      source.checkoutSource.forge !== "github"
    )
      throw new Error("Only GitHub pull-request checkout is supported");
    if (source.kind === "worktree" && source.checkoutSource?.projectPath)
      throw new Error("Cross-repository pull-request checkout is not supported");
    const revision =
      source.kind === "worktree"
        ? (source.baseBranch ?? source.refName ?? project.spec.revision)
        : project.spec.revision;
    const pullRequest =
      source.kind === "worktree"
        ? (source.checkoutSource?.number ?? source.githubPrNumber)
        : undefined;
    const branch =
      source.kind === "worktree"
        ? (source.branchName ??
          (source.action === "checkout" && !pullRequest
            ? source.refName?.replace(/^origin\//, "")
            : undefined))
        : undefined;
    const fingerprint = hash({
      projectId,
      source,
      title: message.title,
      agent: message.agent,
      retentionPolicy,
    });
    const name = message.idempotencyKey
      ? `w-${hash([this.options.namespace, projectId, message.idempotencyKey]).slice(0, 32)}`
      : `w-${randomUUID()}`;
    const expected = WorkspaceSchema.parse({
      apiVersion: API_VERSION,
      kind: "PaseoWorkspace",
      metadata: {
        name,
        namespace: this.options.namespace,
        annotations: { [`${API_GROUP}/creation-hash`]: fingerprint },
      },
      spec: {
        projectRef: project.metadata.name,
        credentialProfile: project.spec.credentialProfile,
        displayName: message.title ?? name,
        residency: "Running",
        revision: revision.replace(/^origin\//, ""),
        ...(branch ? { branch } : {}),
        ...(pullRequest ? { pullRequest } : {}),
        ...(source.kind === "worktree" ? { fetchDepth: 0 } : {}),
        ...(retentionPolicy ? { retentionPolicy } : {}),
      },
    });
    const workspace = await this.options.admission.create(expected, project);
    const annotations = workspace.metadata.annotations;
    if (
      !annotations ||
      typeof annotations !== "object" ||
      object(annotations)[`${API_GROUP}/creation-hash`] !== fingerprint
    )
      throw new Error("Idempotency key conflicts with another workspace request");
    return { workspace, project };
  }

  private async ready(id: string, principal: GatewayPrincipal) {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 300000);
    while (true) {
      const { workspaces } = await this.records(principal);
      const workspace = workspaces.find(
        (row) => row.metadata.name === id && !row.metadata.deletionTimestamp,
      );
      if (!workspace || !authorizeWorkspace(principal, workspace))
        throw new Error("Workspace does not exist or access denied");
      if (workspace.spec.residency !== "Running")
        throw new Error(
          `Workspace ${id} is ${workspace.spec.residency}; resume before creating an agent`,
        );
      if (workspace.status?.phase === "Ready") return workspace;
      if (workspace.status?.phase === "Failed" || Date.now() >= deadline)
        throw new Error(
          `Workspace ${id} ${workspace.status?.phase ?? "Pending"}: ${workspace.status?.message ?? "waiting for Kubernetes scheduling"}`,
        );
      await delay(this.options.pollMs ?? 500);
    }
  }

  private async backend(workspace: Workspace, emit: Emit) {
    const backend =
      this.options.backendFactory?.(workspace, emit) ??
      new PaseoBackend(
        `${this.options.backendSecure ? "wss" : "ws"}://${resourceName(workspace)}.${this.options.namespace}.svc:6767/ws`,
        this.options.backendPassword,
        { type: "hello", clientId: randomUUID(), clientType: "cli", protocolVersion: 1 },
        () => {},
        () => {},
        () => {},
      );
    try {
      await backend.connect();
      const opened = await backend.request({
        type: "open_project_request",
        cwd: workspacePath(workspace.metadata.name),
        requestId: randomUUID(),
      });
      if (opened.type !== "open_project_response" || !opened.payload.workspace)
        throw new Error("Workspace backend registration failed");
      return { backend, localId: opened.payload.workspace.id };
    } catch (error) {
      await backend.close();
      throw error;
    }
  }

  async createAgent(
    message: CreateAgent,
    principal: GatewayPrincipal = owner,
    emit: Emit = () => {},
    progress?: CreationProgress,
    uploads?: UploadStaging,
  ) {
    const { workspaces } = await this.records(principal);
    let workspaceId = message.workspaceId;
    if (!workspaceId)
      workspaceId = workspaces.find(
        (row) => message.config.cwd === workspacePath(row.metadata.name),
      )?.metadata.name;
    const worktree = message.worktree;
    const reusingWorkspace = !!workspaceId && !worktree;
    if (message.git || message.worktreeName)
      throw new Error("Use --new-workspace worktree with explicit branch/base/PR options");
    if (worktree || !workspaceId) {
      const source: CreateWorkspace["source"] = worktree
        ? {
            kind: "worktree",
            cwd: message.config.cwd,
            ...(worktree.mode === "branch-off"
              ? { action: "branch-off", branchName: worktree.newBranch, baseBranch: worktree.base }
              : worktree.mode === "checkout-pr"
                ? { githubPrNumber: worktree.prNumber }
                : { action: "checkout", refName: worktree.branch }),
          }
        : { kind: "directory", path: message.config.cwd };
      await progress?.({}, undefined, true);
      workspaceId = (
        await this.createWorkspace(
          {
            type: "workspace.create.request",
            requestId: message.requestId,
            idempotencyKey: message.idempotencyKey ? `agent:${message.idempotencyKey}` : undefined,
            source,
          },
          principal,
        )
      ).workspace.metadata.name;
    }
    const selected = (await this.records(principal)).workspaces.find(
      (row) => row.metadata.name === workspaceId,
    );
    if (!selected?.metadata.uid || !authorizeWorkspace(principal, selected))
      throw new Error("Workspace access denied");
    await progress?.({ workspaceId }, { workspaceId, workspaceUid: selected.metadata.uid }, false);
    const workspace = await this.ready(workspaceId, principal);
    await progress?.({ phase: "workspace_ready", workspaceId });
    const requestedCwd = posix.normalize(message.config.cwd);
    const root = workspacePath(workspaceId);
    if (reusingWorkspace && requestedCwd !== root && !requestedCwd.startsWith(`${root}/`))
      throw new Error("Agent cwd is outside the selected workspace");
    const { backend, localId } = await this.backend(workspace, emit);
    try {
      // Backend caller IDs are local to a pod. Preserve cross-pod parentage as the
      // upstream label instead of asking a different daemon to resolve that ID.
      let callerAgentId = message.callerAgentId;
      if (callerAgentId) {
        const caller = this.options.agentRouting
          ? await this.options.agentRouting.resolveAgent(
              callerAgentId,
              workspaces.filter((row) => authorizeWorkspace(principal, row)),
            )
          : parseScopedId(callerAgentId);
        const callerWorkspaceId =
          "workspace" in caller ? caller.workspace.metadata.name : caller.workspaceId;
        const origin = workspaces.find((row) => row.metadata.name === callerWorkspaceId);
        if (!origin || !authorizeWorkspace(principal, origin))
          throw new Error("Caller agent workspace access denied");
        if ("backendAgentId" in caller) callerAgentId = caller.backendAgentId;
      }
      let input = SessionInboundMessageSchema.parse(
        translate(
          {
            ...message,
            config: { ...message.config, cwd: reusingWorkspace ? requestedCwd : root },
            workspaceId,
            callerAgentId: undefined,
            worktree: undefined,
            labels: {
              ...message.labels,
              ...(callerAgentId ? { "paseo.parent-agent-id": callerAgentId } : {}),
            },
          },
          workspace,
          localId,
          "in",
        ),
      );
      const fingerprint = hash({ ...message, requestId: undefined, subscribe: undefined });
      const receiptId = message.idempotencyKey
        ? hash([workspace.metadata.uid, message.idempotencyKey])
        : undefined;
      let receipt: ControlRecord<Receipt> | undefined;
      if (receiptId) {
        if (!workspace.metadata.uid)
          throw new Error("Workspace UID is required for creation receipts");
        try {
          receipt = await this.options.store.createRecord<Receipt>({
            kind: "creation",
            id: receiptId,
            value: { fingerprint, workspaceId, workspaceUid: workspace.metadata.uid },
          });
        } catch (error) {
          if (statusCode(error) !== 409) throw error;
          const previous = await this.options.store.record<Receipt>("creation", receiptId);
          if (
            !previous ||
            previous.value.fingerprint !== fingerprint ||
            previous.value.workspaceUid !== workspace.metadata.uid
          )
            throw new Error("Idempotency key conflicts with another agent request");
          if (!previous.value.response)
            throw new Error(
              "Agent creation outcome unknown; inspect the workspace before retrying",
            );
          const response = SessionOutboundMessageSchema.parse(
            this.options.agentRouting
              ? await this.options.agentRouting.project(previous.value.response, workspace)
              : previous.value.response,
          );
          if ("payload" in response && "requestId" in response.payload)
            response.payload.requestId = message.requestId;
          return response;
        }
      }
      const validate = async () => {
        const current = (await this.records(principal)).workspaces.find(
          (row) => row.metadata.name === workspaceId,
        );
        if (
          !current ||
          current.metadata.uid !== workspace.metadata.uid ||
          current.metadata.deletionTimestamp ||
          current.spec.residency !== "Running" ||
          current.status?.phase !== "Ready" ||
          !authorizeWorkspace(principal, current) ||
          (principal.kind === "workspace" && this.options.revokedTokenIds?.has(principal.tokenId))
        )
          throw new Error("Creation workspace access denied or workspace changed");
      };
      await validate();
      let reservedAgentId: string | undefined;
      if (this.options.agentRouting && input.type === "agent.create.request") {
        if (input.agentId) await this.backfillAgentIdentities();
        reservedAgentId = await this.options.agentRouting.reserveForCreate(
          workspace,
          input.agentId ?? randomUUID(),
        );
        input = SessionInboundMessageSchema.parse({ ...input, agentId: reservedAgentId });
      }
      await progress?.({}, undefined, true);
      if (uploads) input = await uploads.replace(input, backend, validate);
      await validate();
      if (reservedAgentId)
        await this.options.agentRouting?.resolveAgent(reservedAgentId, [workspace]);
      await validate();
      const translated = translate(await backend.request(input), workspace, localId, "out");
      const response = SessionOutboundMessageSchema.parse(
        this.options.agentRouting
          ? await this.options.agentRouting.project(translated, workspace)
          : translated,
      );
      if (receipt)
        await this.options.store.updateRecord({
          ...receipt,
          value: { ...receipt.value, response: retainedCreationResponse(response) },
        });
      return response;
    } finally {
      await backend.close();
    }
  }

  async archive(workspaceId: string, principal: GatewayPrincipal) {
    const workspace = (await this.records(principal)).workspaces.find(
      (row) => row.metadata.name === workspaceId,
    );
    if (!workspace || !authorizeWorkspace(principal, workspace))
      throw new Error("Workspace access denied");
    if (workspace.spec.residency === "Archived") return;
    if (workspace.spec.residency === "Suspended")
      await this.options.store.setResidency(workspace, "Running");
    let ready: Workspace;
    try {
      ready = await this.ready(workspaceId, principal);
      await this.snapshotInventory(ready);
      await this.options.store.teardown(ready);
    } catch (error) {
      if (workspace.spec.residency === "Suspended") {
        const current = (await this.options.store.workspaces()).find(
          (row) => row.metadata.name === workspaceId,
        );
        if (current) await this.options.store.setResidency(current, "Suspended");
      }
      throw error;
    }
    if (!ready.status) throw new Error("Workspace readiness status disappeared");
    await this.options.store.status(ready, {
      ...ready.status,
      teardownCompletedAt: new Date().toISOString(),
    });
    // Status updates advance Kubernetes resourceVersion; use a fresh record for
    // the spec mutation and never archive a new object that reused the name.
    const current = (await this.options.store.workspaces()).find(
      (row) => row.metadata.name === workspaceId,
    );
    if (!current || current.metadata.uid !== ready.metadata.uid)
      throw new Error("Workspace changed during archive");
    await this.options.store.setResidency(current, "Archived");
  }

  /** Trusted controller callback also covers archives requested directly through Kubernetes. */
  async snapshotInventory(workspace: Workspace) {
    const { backend, localId } = await this.backend(workspace, () => {});
    try {
      await archiveAgentInventory(this.options.store, backend, workspace, localId);
    } finally {
      await backend.close();
    }
  }

  async snapshotSuspendedInventory(workspace: Workspace) {
    const { backend, localId } = await this.backend(workspace, () => {});
    try {
      await archiveAgentInventory(this.options.store, backend, workspace, localId, "suspended");
    } finally {
      await backend.close();
    }
  }

  /** Resolve a pinned bare UUID against exact backend IDs; the durable binding fences reuse. */
  async resolveScheduleAgent(agentId: string, principal: GatewayPrincipal) {
    const { workspaces } = await this.records(principal);
    const candidates = workspaces.filter((row) => authorizeWorkspace(principal, row));
    const matches: Workspace[] = [];
    let unavailable = false;
    for (const workspace of candidates) {
      if (
        workspace.metadata.deletionTimestamp ||
        workspace.spec.residency !== "Running" ||
        workspace.status?.phase !== "Ready"
      ) {
        unavailable = true;
        continue;
      }
      let connection: Awaited<ReturnType<WorkspaceOperations["backend"]>>;
      try {
        connection = await this.backend(workspace, () => {});
      } catch {
        unavailable = true;
        continue;
      }
      try {
        const response = await connection.backend.request({
          type: "fetch_agent_request",
          requestId: randomUUID(),
          agentId,
        });
        if (response.type !== "fetch_agent_response") throw new Error("Invalid agent lookup");
        if (response.payload.agent?.id === agentId && !response.payload.agent.archivedAt)
          matches.push(workspace);
      } finally {
        await connection.backend.close();
      }
    }
    if (matches.length > 1) throw new Error("Scheduled target UUID is ambiguous across workspaces");
    const workspace = matches[0];
    if (!workspace && unavailable)
      throw new Error("Scheduled target lookup is incomplete while workspaces are unavailable");
    if (!workspace?.metadata.uid) throw new Error("Scheduled target agent does not exist");
    if (this.options.agentRouting) {
      await this.options.agentRouting.claim(workspace, agentId);
      await this.options.agentRouting.resolveAgent(agentId, [workspace]);
    }
    return {
      projectId: workspace.spec.projectRef,
      credentialProfile: workspace.spec.credentialProfile,
      workspaceId: workspace.metadata.name,
      workspaceUid: workspace.metadata.uid,
    };
  }

  async handle(
    message: SessionInboundMessage,
    emit: Emit,
    principal: GatewayPrincipal,
    uploads?: UploadStaging,
  ) {
    if (message.type === "creation.subscribe.request") {
      const observed = await this.journal.subscribe(
        message.kind,
        message.idempotencyKey,
        principal,
        emit,
        message.subscribe !== false,
      );
      emit({
        type: "creation.subscribe.response",
        payload: { requestId: message.requestId, ...observed, error: null },
      });
      return true;
    }
    if (
      message.type === "subscription.release.request" &&
      message.subscriptionId.startsWith("creation:")
    ) {
      this.journal.release(message.subscriptionId, emit);
      emit({
        type: "subscription.release.response",
        payload: { requestId: message.requestId, subscriptionId: message.subscriptionId },
      });
      return true;
    }
    if (message.type === "workspace.create.request" || message.type === "agent.create.request") {
      const kind = message.type === "workspace.create.request" ? "workspace" : "agent";
      const key = message.idempotencyKey ?? message.requestId;
      const snapshot = await this.journal.run(
        kind,
        key,
        { ...message, requestId: undefined, subscribe: undefined },
        principal,
        emit,
        message.subscribe === true,
        async (progress) => {
          const finishAgent = async (input: CreateAgent) => {
            const reply = await this.createAgent(input, principal, emit, progress, uploads);
            if (reply.type === "agent.create.response" && reply.payload.agent) {
              await progress({
                phase: "agent_ready",
                agent: reply.payload.agent,
                agentId: reply.payload.agent.id,
              });
              if (input.initialPrompt) await progress({ phase: "prompt_started" });
            } else {
              const error =
                reply.type === "agent.create.response"
                  ? reply.payload.error
                  : reply.type === "status" && reply.payload.status === "agent_create_failed"
                    ? reply.payload.error
                    : "Agent creation failed";
              await progress({
                phase: "failed",
                error: typeof error === "string" ? error : "Agent creation failed",
                outcomeUnknown: false,
                failedStage: "agent",
              });
            }
          };
          if (message.type === "workspace.create.request") {
            await progress({}, undefined, true);
            const { workspace, project } = await this.createWorkspace(
              { ...message, idempotencyKey: key },
              principal,
            );
            if (!workspace.metadata.uid) throw new Error("Workspace UID required");
            await progress(
              {
                workspaceId: workspace.metadata.name,
                workspace: workspaceDescriptor(workspace, project),
              },
              { workspaceId: workspace.metadata.name, workspaceUid: workspace.metadata.uid },
              false,
            );
            await this.ready(workspace.metadata.name, principal);
            await progress({ phase: "workspace_ready" });
            if (message.agent)
              await finishAgent(
                SessionInboundMessageSchema.parse({
                  ...message.agent,
                  config: { ...message.agent.config, cwd: workspacePath(workspace.metadata.name) },
                  type: "agent.create.request",
                  requestId: message.requestId,
                  workspaceId: workspace.metadata.name,
                  idempotencyKey: `initial:${key}`,
                }) as CreateAgent,
              );
          } else await finishAgent({ ...message, idempotencyKey: key });
        },
      );
      await this.records(principal);
      emit(
        message.type === "workspace.create.request"
          ? {
              type: "workspace.create.response",
              payload: {
                requestId: message.requestId,
                workspace: snapshot.workspace ?? null,
                agent: snapshot.agent,
                setupTerminalId: null,
                error: snapshot.error,
                creation: snapshot,
              },
            }
          : {
              type: "agent.create.response",
              payload: {
                requestId: message.requestId,
                agent: snapshot.agent ?? null,
                error: snapshot.error,
                creation: snapshot,
              },
            },
      );
      return true;
    }
    if (message.type === "create_agent_request") {
      emit(await this.createAgent(message, principal, emit, undefined, uploads));
      return true;
    }
    if (message.type === "archive_workspace_request") {
      await this.archive(message.workspaceId, principal);
      emit({
        type: "archive_workspace_response",
        payload: {
          requestId: message.requestId,
          workspaceId: message.workspaceId,
          archivedAt: new Date().toISOString(),
          error: null,
        },
      });
      return true;
    }
    return false;
  }

  async dispatchSchedule(input: {
    schedule: StoredSchedule;
    runId: string;
    projectId: string;
    credentialProfile: string;
    targetWorkspaceId?: string;
    targetWorkspaceUid?: string;
    origin?: {
      workspaceId: string;
      workspaceUid: string;
      expiresAt: number;
      tokenId: string;
    };
  }) {
    if (input.origin) {
      const workspaces = await this.options.store.workspaces();
      const source = workspaces.find((row) => row.metadata.name === input.origin?.workspaceId);
      if (
        !source ||
        source.metadata.uid !== input.origin.workspaceUid ||
        source.metadata.deletionTimestamp ||
        source.spec.residency !== "Running" ||
        input.origin.expiresAt <= Math.floor(Date.now() / 1000) ||
        this.options.revokedTokenIds?.has(input.origin.tokenId)
      )
        throw new ScheduleDispatchRejected("Scheduled origin authorization expired or was revoked");
    }
    if (input.schedule.target.type === "agent") {
      const workspace = (await this.options.store.workspaces()).find(
        (row) => row.metadata.name === input.targetWorkspaceId,
      );
      if (
        !workspace ||
        !input.targetWorkspaceUid ||
        workspace.metadata.uid !== input.targetWorkspaceUid ||
        workspace.metadata.deletionTimestamp ||
        workspace.spec.projectRef !== input.projectId ||
        workspace.spec.credentialProfile !== input.credentialProfile ||
        workspace.spec.residency !== "Running" ||
        workspace.status?.phase !== "Ready"
      )
        throw new ScheduleDispatchRejected("Scheduled target workspace is unavailable or changed");
      const backend = await this.backend(workspace, () => {}).catch((error) => {
        throw new ScheduleDispatchRejected(
          error instanceof Error ? error.message : "Scheduled target backend unavailable",
        );
      });
      try {
        const validateDispatch = async () => {
          const latest = await this.options.store.workspaces();
          const current = latest.find((row) => row.metadata.name === input.targetWorkspaceId);
          const origin = input.origin
            ? latest.find((row) => row.metadata.name === input.origin?.workspaceId)
            : undefined;
          if (
            !current ||
            current.metadata.uid !== input.targetWorkspaceUid ||
            current.metadata.deletionTimestamp ||
            current.spec.residency !== "Running" ||
            current.status?.phase !== "Ready" ||
            current.spec.projectRef !== input.projectId ||
            current.spec.credentialProfile !== input.credentialProfile ||
            (input.origin &&
              (!origin ||
                origin.metadata.uid !== input.origin.workspaceUid ||
                origin.metadata.deletionTimestamp ||
                origin.spec.residency !== "Running" ||
                input.origin.expiresAt <= Math.floor(Date.now() / 1000) ||
                this.options.revokedTokenIds?.has(input.origin.tokenId)))
          )
            throw new ScheduleDispatchRejected(
              "Scheduled target or origin changed before dispatch",
            );
          return current;
        };
        const target = await backend.backend
          .request({
            type: "fetch_agent_request",
            requestId: randomUUID(),
            agentId: input.schedule.target.agentId,
          })
          .catch((error) => {
            throw new ScheduleDispatchRejected(
              error instanceof Error ? error.message : "Scheduled target lookup failed",
            );
          });
        if (
          target.type !== "fetch_agent_response" ||
          target.payload.agent?.id !== input.schedule.target.agentId ||
          target.payload.agent.archivedAt
        )
          throw new ScheduleDispatchRejected("Scheduled target agent is unavailable or archived");
        const current = await validateDispatch();
        if (this.options.agentRouting) {
          await this.options.agentRouting.claim(current, input.schedule.target.agentId);
          const route = await this.options.agentRouting.resolveAgent(
            input.schedule.target.agentId,
            [current],
          );
          if (route.workspace.metadata.uid !== input.targetWorkspaceUid)
            throw new ScheduleDispatchRejected("Scheduled target agent identity changed");
        }
        await validateDispatch();
        // After this mutation is sent, any lost response is ambiguous and is never retried.
        const response = await backend.backend.request({
          type: "send_agent_message_request",
          requestId: input.runId,
          agentId: input.schedule.target.agentId,
          text: input.schedule.prompt,
          messageId: input.runId,
        });
        if (
          response.type !== "send_agent_message_response" ||
          !response.payload.accepted ||
          response.payload.error
        )
          throw new Error("Scheduled target message outcome is unknown");
        return { workspaceId: workspace.metadata.name, agentId: input.schedule.target.agentId };
      } finally {
        await backend.backend.close();
      }
    }
    const project = (await this.options.store.projects()).find(
      (row) =>
        row.metadata.name === input.projectId &&
        row.spec.credentialProfile === input.credentialProfile,
    );
    if (!project)
      throw new ScheduleDispatchRejected("Schedule project or credential profile changed");
    let workspace: Workspace;
    try {
      ({ workspace } = await this.createWorkspace(
        {
          type: "workspace.create.request",
          requestId: input.runId,
          idempotencyKey: `schedule:${input.runId}`,
          title: input.schedule.name ?? `Schedule ${input.schedule.id}`,
          source: {
            kind: "directory",
            projectId: input.projectId,
            path: projectPath(input.projectId),
          },
        },
        owner,
        {
          storage: "Retain",
          ttlAfterArchivedSeconds: this.options.scheduleRetentionSeconds ?? 86400,
        },
      ));
    } catch (error) {
      throw new ScheduleDispatchRejected(
        error instanceof Error ? error.message : "Schedule workspace allocation failed",
      );
    }
    const response = await this.createAgent(
      SessionInboundMessageSchema.parse({
        type: "agent.create.request",
        requestId: input.runId,
        idempotencyKey: `schedule:${input.runId}`,
        workspaceId: workspace.metadata.name,
        config: { ...input.schedule.target.config, cwd: workspacePath(workspace.metadata.name) },
        initialPrompt: input.schedule.prompt,
        autoArchive: input.schedule.target.config.archiveOnFinish,
        labels: { "paseo.schedule-id": input.schedule.id },
      }) as CreateAgent,
    );
    if (response.type !== "agent.create.response" || !response.payload.agent)
      throw new ScheduleDispatchRejected(
        response.type === "agent.create.response"
          ? (response.payload.error ?? "Scheduled agent creation failed")
          : "Scheduled agent creation failed",
      );
    return {
      workspaceId: workspace.metadata.name,
      agentId: this.options.agentRouting
        ? response.payload.agent.id
        : parseScopedId(response.payload.agent.id).backendId,
    };
  }

  async observeSchedule(input: {
    scheduleId: string;
    run: ScheduleRun;
    targetWorkspaceUid?: string;
  }): Promise<{ status: "succeeded" | "failed"; output?: string; error?: string } | undefined> {
    if (!input.run.workspaceId || !input.run.agentId) return undefined;
    const workspace = (await this.options.store.workspaces()).find(
      (row) => row.metadata.name === input.run.workspaceId,
    );
    if (input.targetWorkspaceUid && workspace?.metadata.uid !== input.targetWorkspaceUid)
      return { status: "failed", error: "Scheduled target workspace was replaced" };
    if (!workspace || workspace.status?.phase === "Failed")
      return { status: "failed", error: workspace?.status?.message ?? "Workspace disappeared" };
    if (workspace.status?.phase !== "Ready") return undefined;
    const { backend } = await this.backend(workspace, () => {});
    try {
      const response = await backend.request({
        type: "wait_for_finish_request",
        agentId: input.run.agentId,
        requestId: randomUUID(),
        timeoutMs: 1,
      });
      if (response.type !== "wait_for_finish_response")
        throw new Error("Unexpected scheduled agent observation");
      if (response.payload.status === "timeout") return undefined;
      if (input.targetWorkspaceUid) {
        type TimelineEntry = Extract<
          SessionOutboundMessage,
          { type: "fetch_agent_timeline_response" }
        >["payload"]["entries"][number];
        const entries: TimelineEntry[] = [];
        let cursor: { epoch: string; seq: number } | undefined;
        let found = false;
        for (let page = 0; page < 10; page++) {
          const timeline = await backend.request({
            type: "fetch_agent_timeline_request",
            requestId: randomUUID(),
            agentId: input.run.agentId,
            direction: cursor ? "before" : "tail",
            ...(cursor ? { cursor } : {}),
            limit: 200,
            projection: "canonical",
          });
          if (timeline.type !== "fetch_agent_timeline_response" || timeline.payload.error)
            throw new Error("Scheduled target timeline is unavailable");
          entries.push(...timeline.payload.entries);
          found = entries.some(
            (entry) => entry.item.type === "user_message" && entry.item.messageId === input.run.id,
          );
          if (found || !timeline.payload.hasOlder || !timeline.payload.startCursor) break;
          cursor = timeline.payload.startCursor;
        }
        if (!found) return undefined;
        const prompt = entries.find(
          (entry) => entry.item.type === "user_message" && entry.item.messageId === input.run.id,
        );
        if (!prompt) return undefined;
        const nextUser = entries
          .filter((entry) => entry.seqStart > prompt.seqEnd && entry.item.type === "user_message")
          .sort((a, b) => a.seqStart - b.seqStart)[0];
        const completed = entries.some(
          (entry) =>
            entry.seqStart > prompt.seqEnd &&
            (!nextUser || entry.seqStart < nextUser.seqStart) &&
            entry.item.type === "assistant_message" &&
            (!prompt.turnId || entry.turnId === prompt.turnId),
        );
        if (response.payload.status === "idle" && !completed) return undefined;
      }
      if (!input.targetWorkspaceUid) {
        try {
          await this.archive(workspace.metadata.name, owner);
        } catch (error) {
          return {
            status: "failed",
            error: `Agent completed but workspace teardown failed; compute and storage retained: ${error instanceof Error ? error.message : "unknown error"}`,
          };
        }
      }
      if (response.payload.status === "idle")
        return { status: "succeeded", output: response.payload.lastMessage ?? undefined };
      return {
        status: "failed",
        error:
          response.payload.error ??
          response.payload.final?.lastError ??
          `Agent ended with ${response.payload.status}`,
      };
    } finally {
      await backend.close();
    }
  }
}
