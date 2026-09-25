import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { V1Pod } from "@kubernetes/client-node";
import type { RuntimeConfig } from "../controller/resources.js";
import { credentialProjection } from "../credentials/projection.js";
import {
  API_GROUP,
  API_VERSION,
  type CredentialProfile,
  MANAGED_BY,
  type Project,
  type Workspace,
} from "../domain.js";
import type { ControlRecord, RecordStore } from "../kubernetes/records.js";
import type { Store } from "../kubernetes/store.js";
import { statusCode } from "../kubernetes/store.js";
import { effectiveWorkspaceImage } from "./provider-catalog.js";

const RUN_LABEL = `${API_GROUP}/ref-inspection-run`;
const MAX_WAIT_MS = 43_000;
const MAX_MESSAGE_BYTES = 3_800;
const MAX_ACTIVE = 2;
const MAX_WAITING = 16;
const MAX_QUEUE_MS = 3_000;
const RUN_KIND = "project-ref-inspection";
const STALE_AFTER_MS = 90_000;

interface RefRun {
  runId: string;
  name: string;
  projectUid: string;
  startedAt: string;
  podUid?: string;
}

function runName(runId: string) {
  return `refs-${runId.replace(/-/g, "").slice(0, 24)}`;
}

export type ProjectRefQuery =
  | { mode: "suggest"; query?: string; limit?: number }
  | { mode: "validate"; branchName: string };
export type ProjectRefResult =
  | { mode: "suggest"; refs: string[] }
  | { mode: "validate"; valid: boolean; exists: boolean };

function resource(input: {
  project: Project;
  profile: CredentialProfile;
  runtime: RuntimeConfig;
  runId: string;
  query: ProjectRefQuery;
}): V1Pod {
  const { project, profile, runtime, runId, query } = input;
  if (!project.metadata.uid || profile.metadata.name !== project.spec.credentialProfile)
    throw new Error("Project ref inspection identity is unavailable");
  if (profile.metadata.namespace !== project.metadata.namespace)
    throw new Error("Project ref inspection profile namespace differs");
  const workspace: Workspace = {
    apiVersion: API_VERSION,
    kind: "PaseoWorkspace",
    metadata: {
      name: runName(runId),
      namespace: project.metadata.namespace,
      uid: runId,
    },
    spec: {
      projectRef: project.metadata.name,
      credentialProfile: profile.metadata.name,
      displayName: "Ref inspection",
      revision: project.spec.revision,
      residency: "Running",
    },
  };
  const gitOnlyProfile: CredentialProfile = {
    ...profile,
    spec: {
      ...profile.spec,
      env: [],
      files: [],
      codexSubscription: undefined,
      git: profile.spec.git ? { ...profile.spec.git, signing: undefined } : undefined,
    },
  };
  const credentials = credentialProjection(workspace, project, gitOnlyProfile);
  const name = runName(runId);
  const labels = {
    "app.kubernetes.io/managed-by": MANAGED_BY,
    "app.kubernetes.io/component": "workspace",
    [`${API_GROUP}/credential-profile`]: profile.metadata.name,
    [RUN_LABEL]: runId,
    [`${API_GROUP}/project`]: project.metadata.name,
  };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: project.metadata.namespace,
      labels,
      ownerReferences: [
        {
          apiVersion: API_VERSION,
          kind: "PaseoProject",
          name: project.metadata.name,
          uid: project.metadata.uid,
          controller: true,
          blockOwnerDeletion: false,
        },
      ],
    },
    spec: {
      serviceAccountName: "paseo-workspace",
      automountServiceAccountToken: false,
      restartPolicy: "Never",
      activeDeadlineSeconds: 50,
      terminationGracePeriodSeconds: 5,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "inspect",
          image: effectiveWorkspaceImage({
            project,
            profile,
            defaultImage: runtime.workspaceImage,
          }),
          imagePullPolicy: runtime.imagePullPolicy,
          command: ["node", "/opt/paseo/inspect-refs.mjs"],
          env: [
            ...credentials.env,
            { name: "HOME", value: "/tmp/home" },
            { name: "REPOSITORY", value: project.spec.repository },
            { name: "REF_MODE", value: query.mode },
            ...(query.mode === "suggest"
              ? [
                  { name: "REF_QUERY", value: query.query ?? "" },
                  { name: "REF_LIMIT", value: String(query.limit ?? 20) },
                ]
              : [{ name: "REF_NAME", value: query.branchName }]),
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            requests: { cpu: "50m", memory: "64Mi" },
            limits: { cpu: "500m", memory: "256Mi" },
          },
          volumeMounts: [
            ...credentials.checkoutMounts.filter(
              (mount) => mount.name === "git-token" || mount.name === "git-ssh",
            ),
            { name: "tmp", mountPath: "/tmp" },
          ],
          terminationMessagePath: "/dev/termination-log",
          terminationMessagePolicy: "File",
        },
      ],
      volumes: [
        ...credentials.volumes.filter(
          (volume) => volume.name === "git-token" || volume.name === "git-ssh",
        ),
        { name: "tmp", emptyDir: { sizeLimit: "16Mi" } },
      ],
    },
  };
}

function owned(
  pod: V1Pod | undefined,
  name: string,
  runId: string,
  projectUid: string,
  uid?: string,
) {
  return (
    !!pod &&
    pod.metadata?.name === name &&
    !!pod.metadata.uid &&
    (!uid || pod.metadata.uid === uid) &&
    pod.metadata.labels?.[RUN_LABEL] === runId &&
    pod.metadata.ownerReferences?.some(
      (owner) => owner.kind === "PaseoProject" && owner.uid === projectUid,
    ) === true
  );
}

function decode(message: string | undefined, query: ProjectRefQuery): ProjectRefResult {
  if (!message || Buffer.byteLength(message) > MAX_MESSAGE_BYTES)
    throw new Error("Project ref inspection result is unavailable");
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new Error("Project ref inspection result is invalid");
  }
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1)
    throw new Error("Project ref inspection result is invalid");
  const row = value as Record<string, unknown>;
  if (row.error) throw new Error("Project ref inspection failed; retry shortly");
  if (query.mode === "validate") {
    if (typeof row.valid !== "boolean" || typeof row.exists !== "boolean")
      throw new Error("Project ref validation result is invalid");
    return { mode: "validate", valid: row.valid, exists: row.exists };
  }
  if (
    !Array.isArray(row.refs) ||
    row.refs.length > 20 ||
    row.refs.some(
      (ref) =>
        typeof ref !== "string" ||
        ref.length > 200 ||
        ref.length === 0 ||
        Array.from(ref).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  )
    throw new Error("Project ref suggestions are invalid");
  return { mode: "suggest", refs: row.refs as string[] };
}

/** Disposable, Project-owned Git read. No gateway-host checkout or credential values. */
export class ProjectRefInspector {
  private active = 0;
  private waiting = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(
    private readonly options: {
      store: Store & RecordStore;
      runtime: RuntimeConfig;
      now?: () => number;
      wait?: (ms: number) => Promise<void>;
    },
  ) {}

  /** Called on startup and periodically. A receipt survives any crash between
   * Pod create, UID capture, and deletion, without needing broad Pod list RBAC.
   */
  async recoverExpired(): Promise<void> {
    let incomplete = false;
    for (const record of await this.options.store.records<RefRun>(RUN_KIND)) {
      const run = record.value;
      if (
        !run ||
        run.runId !== record.id ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(run.runId) ||
        run.name !== runName(run.runId) ||
        !run.projectUid ||
        !Number.isFinite(Date.parse(run.startedAt))
      ) {
        incomplete = true;
        continue;
      }
      if (Date.parse(run.startedAt) + STALE_AFTER_MS > (this.options.now ?? Date.now)()) continue;
      try {
        await this.cleanupRun(record, undefined, true);
      } catch {
        incomplete = true;
      }
    }
    if (incomplete) throw new Error("Project ref inspection recovery is incomplete");
  }

  private async cleanupRun(
    record: ControlRecord<RefRun>,
    knownPodUid?: string,
    expired = false,
  ): Promise<void> {
    const run = record.value;
    const expectedUid = knownPodUid ?? run.podUid;
    // A live writer without an acknowledged Pod UID cannot distinguish its
    // Pod from a replacement. Only expired recovery may use the run/owner pair.
    if (!expectedUid && !expired) throw new Error("Project ref inspection Pod UID is unavailable");
    const current = await this.options.store.get("Pod", run.name);
    if (current) {
      if (
        !current.spec ||
        !("containers" in current.spec) ||
        !owned(current as V1Pod, run.name, run.runId, run.projectUid, expectedUid)
      )
        throw new Error("Project ref inspection Pod identity changed");
      const podUid = current.metadata?.uid;
      if (!podUid) throw new Error("Project ref inspection Pod UID is unavailable");
      await this.options.store.deletePod(run.name, podUid).catch((error: unknown) => {
        if (statusCode(error) !== 404) throw error;
      });
      const now = this.options.now ?? Date.now;
      const wait = this.options.wait ?? ((ms: number) => delay(ms));
      const deadline = now() + 10_000;
      while (now() < deadline) {
        if ((await this.options.store.get("Pod", run.name))?.metadata?.uid !== podUid) break;
        await wait(250);
      }
      if ((await this.options.store.get("Pod", run.name))?.metadata?.uid === podUid)
        throw new Error("Project ref inspection cleanup is incomplete");
    }
    const latest = await this.options.store.record<RefRun>(RUN_KIND, run.runId);
    if (!latest) return;
    if (
      latest.value.runId !== run.runId ||
      latest.value.name !== run.name ||
      latest.value.projectUid !== run.projectUid ||
      latest.value.podUid !== run.podUid
    )
      throw new Error("Project ref inspection receipt changed");
    await this.options.store.deleteRecord(latest);
  }

  async query(input: {
    project: Project;
    profile: CredentialProfile;
    query: ProjectRefQuery;
  }): Promise<ProjectRefResult> {
    if (input.query.mode === "suggest" && (input.query.query?.length ?? 0) > 200)
      throw new Error("Project ref query exceeds its length limit");
    if (input.query.mode === "validate" && input.query.branchName.length > 200)
      throw new Error("Project branch name exceeds its length limit");
    const queued = this.active >= MAX_ACTIVE;
    if (queued) {
      if (this.waiting >= MAX_WAITING)
        throw new Error("Project ref inspection is busy; retry shortly");
      this.waiting++;
      try {
        await new Promise<void>((resolve, reject) => {
          const accept = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            this.waiters.splice(this.waiters.indexOf(accept), 1);
            reject(new Error("Project ref inspection is busy; retry shortly"));
          }, MAX_QUEUE_MS);
          this.waiters.push(accept);
        });
      } finally {
        this.waiting--;
      }
    }
    if (!queued) this.active++;
    try {
      return await this.run(input);
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async run(input: {
    project: Project;
    profile: CredentialProfile;
    query: ProjectRefQuery;
  }): Promise<ProjectRefResult> {
    const runId = randomUUID();
    const pod = resource({ ...input, runtime: this.options.runtime, runId });
    const name = pod.metadata?.name;
    const projectUid = input.project.metadata.uid;
    if (!name || !projectUid) throw new Error("Project ref inspection identity is unavailable");
    const now = this.options.now ?? Date.now;
    const wait = this.options.wait ?? ((ms: number) => delay(ms));
    const run: RefRun = {
      runId,
      name,
      projectUid,
      startedAt: new Date(now()).toISOString(),
    };
    let uid: string | undefined;
    let answer: ProjectRefResult | undefined;
    let failure: unknown;
    try {
      const receipt = await this.options.store.createRecord<RefRun>({
        kind: RUN_KIND,
        id: runId,
        value: run,
      });
      const created = await this.options.store.create(pod);
      if (
        !created.spec ||
        !("containers" in created.spec) ||
        !owned(created as V1Pod, name, runId, projectUid)
      )
        throw new Error("Project ref inspection Pod identity changed");
      uid = created.metadata?.uid;
      if (!uid) throw new Error("Project ref inspection Pod UID is unavailable");
      await this.options.store.updateRecord<RefRun>({
        ...receipt,
        value: { ...run, podUid: uid },
      });
      const deadline = now() + MAX_WAIT_MS;
      while (now() < deadline) {
        const current = await this.options.store.get("Pod", name);
        if (
          !current?.spec ||
          !("containers" in current.spec) ||
          !owned(current as V1Pod, name, runId, projectUid, uid)
        )
          throw new Error("Project ref inspection Pod identity changed");
        const state = (current as V1Pod).status?.containerStatuses?.find(
          (entry) => entry.name === "inspect",
        )?.state?.terminated;
        if (state) {
          answer = decode(state.message, input.query);
          if (state.exitCode !== 0) throw new Error("Project ref inspection failed; retry shortly");
          break;
        }
        await wait(500);
      }
      if (!answer) throw new Error("Project ref inspection timed out; retry shortly");
    } catch (error) {
      failure = error;
    }
    try {
      const receipt = await this.options.store.record<RefRun>(RUN_KIND, runId);
      if (receipt) {
        if (
          receipt.value.runId !== runId ||
          receipt.value.name !== name ||
          receipt.value.projectUid !== projectUid ||
          (uid && receipt.value.podUid && receipt.value.podUid !== uid)
        )
          throw new Error("Project ref inspection receipt changed");
        await this.cleanupRun(receipt, uid);
      }
    } catch {
      throw new Error("Project ref inspection cleanup is incomplete");
    }
    if (failure) throw new Error("Project ref inspection failed; retry shortly");
    if (!answer) throw new Error("Project ref inspection result is unavailable");
    return answer;
  }
}
