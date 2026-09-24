import { createHash, randomUUID } from "node:crypto";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { RuntimeConfig } from "../controller/resources.js";
import { referencedCredentials } from "../credentials/projection.js";
import type { CredentialProfile, Project } from "../domain.js";
import type { ControlRecord, RecordStore } from "../kubernetes/records.js";
import type { Store } from "../kubernetes/store.js";
import { statusCode } from "../kubernetes/store.js";
import { effectiveWorkspaceImage } from "./provider-catalog.js";
import {
  ProviderProbe,
  ProviderProbeCleanupError,
  type ProviderProbeReceipts,
  type ProviderProbeResult,
} from "./provider-probe.js";

const RECORD_KIND = "provider-catalog";
const VERIFIED_TTL_MS = 15 * 60_000;
const RETRY_DELAY_MS = 30_000;
const MAX_PENDING = 32;
const MAX_CONCURRENT = 2;
const STALE_AFTER_MS = 6 * 60_000;

type KnownProvider = Pick<ProviderSnapshotEntry, "provider" | "label">;
function knownProviders(entries: readonly ProviderSnapshotEntry[]): KnownProvider[] {
  return entries
    .filter((entry) => entry.enabled !== false)
    .map(({ provider, label }) => ({ provider, label }));
}
function failedEntries(providers: readonly KnownProvider[], code: string): ProviderSnapshotEntry[] {
  return providers.map(({ provider, label }) => ({
    provider,
    label,
    status: "error",
    enabled: true,
    models: [],
    error: `Provider discovery ${code}; retry after the bounded backoff`,
  }));
}

type CatalogRecord =
  | {
      state: "probing";
      fingerprint: string;
      projectUid: string;
      runId: string;
      name: string;
      startedAt: string;
      receipts: ProviderProbeReceipts;
      knownProviders: KnownProvider[];
    }
  | {
      state: "verified";
      fingerprint: string;
      entries: ProviderSnapshotEntry[];
      fetchedAt: string;
      expiresAt: string;
    }
  | {
      state: "failed";
      fingerprint: string;
      code: string;
      retryAt: string;
      entries: ProviderSnapshotEntry[];
    };

export interface CatalogIdentity {
  project: Project;
  profile: CredentialProfile;
  fingerprint: string;
}

export interface CatalogStore extends Store, RecordStore {}

export interface ProviderCatalogOptions {
  store: CatalogStore;
  namespace: string;
  backendPassword: string;
  backendSecure: boolean;
  runtime: RuntimeConfig;
  now?: () => number;
  probe?: Pick<ProviderProbe, "run" | "cleanup">;
  pollMs?: number;
  configAuditMs?: number;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

export class ProviderCatalog {
  private readonly now: () => number;
  private readonly probe: Pick<ProviderProbe, "run" | "cleanup">;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly watchers = new Map<string, Set<(entries: ProviderSnapshotEntry[]) => void>>();
  private readonly retries = new Map<string, NodeJS.Timeout>();
  private readonly staleSweeps = new Map<string, NodeJS.Timeout>();
  private readonly recordPolls = new Map<string, NodeJS.Timeout>();
  private readonly recordVersions = new Map<string, string | undefined>();
  private readonly configAudits = new Map<string, number>();
  private readonly permitQueue: Array<() => void> = [];
  private activeProbes = 0;

  constructor(private readonly options: ProviderCatalogOptions) {
    this.now = options.now ?? Date.now;
    this.probe =
      options.probe ??
      new ProviderProbe({
        store: options.store,
        namespace: options.namespace,
        backendPassword: options.backendPassword,
        backendSecure: options.backendSecure,
        runtime: options.runtime,
      });
  }

  /** Reclaim only expired runs; an old gateway may still be finishing during a rollout. */
  async initialize(): Promise<void> {
    for (const record of await this.options.store.records<CatalogRecord>(RECORD_KIND)) {
      if (record.value.state !== "probing") continue;
      if (!(await this.reclaimExpired(record.id, record.value).catch(() => false)))
        this.scheduleStaleSweep(record.id, record.value);
    }
  }

  watch(projectId: string, callback: (entries: ProviderSnapshotEntry[]) => void): () => void {
    const watchers = this.watchers.get(projectId) ?? new Set();
    watchers.add(callback);
    this.watchers.set(projectId, watchers);
    this.startRecordPoll(projectId);
    return () => {
      watchers.delete(callback);
      if (watchers.size === 0) {
        this.watchers.delete(projectId);
        const timer = this.recordPolls.get(projectId);
        if (timer) clearInterval(timer);
        this.recordPolls.delete(projectId);
        this.recordVersions.delete(projectId);
        this.configAudits.delete(projectId);
      }
    };
  }

  private startRecordPoll(projectId: string) {
    if (this.recordPolls.has(projectId)) return;
    let reading = false;
    const timer = setInterval(() => {
      if (reading || !this.watchers.has(projectId)) return;
      reading = true;
      void (async () => {
        const record = await this.options.store.record<CatalogRecord>(RECORD_KIND, projectId);
        if (
          record &&
          (!this.recordVersions.has(projectId) ||
            this.recordVersions.get(projectId) !== record.version)
        ) {
          this.recordVersions.set(projectId, record.version);
          if (record.value.state === "verified") this.publish(projectId, record.value.entries);
          if (record.value.state === "probing") this.scheduleStaleSweep(projectId, record.value);
          if (record.value.state === "failed") {
            this.publish(projectId, record.value.entries ?? []);
            const project = (await this.options.store.projects()).find(
              (row) => row.metadata.name === projectId,
            );
            if (project?.metadata.uid) this.scheduleRetry(projectId, project.metadata.uid);
          }
        }
        const lastAudit = this.configAudits.get(projectId);
        if (
          lastAudit === undefined ||
          this.now() - lastAudit >= (this.options.configAuditMs ?? 30_000)
        ) {
          this.configAudits.set(projectId, this.now());
          const project = (await this.options.store.projects()).find(
            (row) => row.metadata.name === projectId,
          );
          if (project) await this.snapshot(project).catch(() => {});
        }
      })()
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    }, this.options.pollMs ?? 5_000);
    timer.unref();
    this.recordPolls.set(projectId, timer);
  }

  private publish(projectId: string, entries: ProviderSnapshotEntry[]) {
    for (const callback of this.watchers.get(projectId) ?? []) callback(entries);
  }

  private scheduleRetry(projectId: string, projectUid: string) {
    if (this.retries.has(projectId) || !this.watchers.has(projectId)) return;
    const timer = setTimeout(() => {
      this.retries.delete(projectId);
      void (async () => {
        const project = (await this.options.store.projects()).find(
          (row) => row.metadata.name === projectId && row.metadata.uid === projectUid,
        );
        if (!project || !this.watchers.has(projectId)) return;
        const entries = await this.snapshot(project);
        if (entries.length) this.publish(projectId, entries);
      })().catch(() => this.scheduleRetry(projectId, projectUid));
    }, RETRY_DELAY_MS);
    timer.unref();
    this.retries.set(projectId, timer);
  }

  private scheduleStaleSweep(id: string, run: Extract<CatalogRecord, { state: "probing" }>) {
    if (this.staleSweeps.has(id)) return;
    const remaining = Math.max(1_000, Date.parse(run.startedAt) + STALE_AFTER_MS - this.now());
    const timer = setTimeout(() => {
      this.staleSweeps.delete(id);
      void (async () => {
        const current = await this.options.store.record<CatalogRecord>(RECORD_KIND, id);
        if (current?.value.state !== "probing" || current.value.runId !== run.runId) return;
        if (!(await this.reclaimExpired(id, current.value)))
          this.scheduleStaleSweep(id, current.value);
      })().catch(() => this.scheduleStaleSweep(id, run));
    }, remaining);
    timer.unref();
    this.staleSweeps.set(id, timer);
  }

  async identity(project: Project): Promise<CatalogIdentity> {
    if (!project.metadata.uid) throw new Error("Provider discovery requires a project UID");
    const profile = await this.options.store.credentialProfile(project.spec.credentialProfile);
    if (!profile || profile.metadata.namespace !== project.metadata.namespace)
      throw new Error("Provider discovery credential profile is unavailable");
    const references = await Promise.all(
      referencedCredentials(profile).map(async (reference) => {
        const object =
          reference.kind === "Secret"
            ? await this.options.store.secret(reference.name)
            : await this.options.store.configMap(reference.name);
        if (!object.data || !Object.hasOwn(object.data, reference.key))
          throw new Error("Provider discovery credential reference is unavailable");
        return {
          kind: reference.kind,
          name: reference.name,
          key: reference.key,
          uid: object.metadata?.uid,
          version: object.metadata?.resourceVersion,
        };
      }),
    );
    const image = effectiveWorkspaceImage({
      project,
      profile,
      defaultImage: this.options.runtime.workspaceImage,
    });
    return {
      project,
      profile,
      fingerprint: fingerprint({
        project: { uid: project.metadata.uid, spec: project.spec },
        profile: { uid: profile.metadata.uid, spec: profile.spec },
        references,
        image,
      }),
    };
  }

  async snapshot(project: Project, force = false): Promise<ProviderSnapshotEntry[]> {
    const projectId = project.metadata.name;
    let identity: CatalogIdentity;
    try {
      identity = await this.identity(project);
    } catch {
      if (project.metadata.uid) this.scheduleRetry(projectId, project.metadata.uid);
      throw new Error("Provider discovery configuration or credential output is unavailable");
    }
    const record = await this.options.store.record<CatalogRecord>(RECORD_KIND, projectId);
    if (!force && record?.value.fingerprint === identity.fingerprint) {
      if (record.value.state === "verified" && Date.parse(record.value.expiresAt) > this.now())
        return record.value.entries;
      if (record.value.state === "failed" && Date.parse(record.value.retryAt) > this.now()) {
        if (record.value.entries?.length) return record.value.entries;
        throw new Error(
          `Provider discovery unavailable (${record.value.code}); retry after the bounded backoff`,
        );
      }
    }
    if (this.pending.has(projectId)) return [];
    if (this.pending.size >= MAX_PENDING) throw new Error("Provider discovery queue is full");
    if (record?.value.state === "probing") {
      if (Date.parse(record.value.startedAt) + STALE_AFTER_MS > this.now()) {
        this.scheduleStaleSweep(projectId, record.value);
        return [];
      }
      if (!(await this.reclaimExpired(projectId, record.value))) return [];
    }
    const work = this.run(identity, force).finally(() => this.pending.delete(projectId));
    this.pending.set(projectId, work);
    return [];
  }

  private async reclaimExpired(
    id: string,
    run: Extract<CatalogRecord, { state: "probing" }>,
  ): Promise<boolean> {
    if (Date.parse(run.startedAt) + STALE_AFTER_MS > this.now()) return false;
    // No live writer may still be using an expired run. A missing receipt is a
    // possible crash between Kubernetes create and record CAS, so the immutable
    // run label and owner UID are the fallback fence after its deadline.
    await this.probe.cleanup(run.name, run.projectUid, run.runId, run.receipts, true);
    const reclaimed = await this.put(
      id,
      {
        state: "failed",
        fingerprint: run.fingerprint,
        code: "interrupted",
        retryAt: new Date(this.now()).toISOString(),
        entries: failedEntries(run.knownProviders ?? [], "interrupted"),
      },
      (current) => current?.value.state === "probing" && current.value.runId === run.runId,
    );
    if (reclaimed) {
      const timer = this.staleSweeps.get(id);
      if (timer) clearTimeout(timer);
      this.staleSweeps.delete(id);
      this.scheduleRetry(id, run.projectUid);
    }
    return !!reclaimed;
  }

  private async acquire(): Promise<() => void> {
    if (this.activeProbes >= MAX_CONCURRENT)
      await new Promise<void>((resolve) => this.permitQueue.push(resolve));
    else this.activeProbes++;
    return () => {
      const next = this.permitQueue.shift();
      if (next) next();
      else this.activeProbes--;
    };
  }

  private async run(identity: CatalogIdentity, force: boolean) {
    const release = await this.acquire();
    const projectId = identity.project.metadata.name;
    let runId: string | undefined;
    try {
      const currentProject = (await this.options.store.projects()).find(
        (row) =>
          row.metadata.name === projectId && row.metadata.uid === identity.project.metadata.uid,
      );
      if (
        !currentProject ||
        (await this.identity(currentProject)).fingerprint !== identity.fingerprint
      )
        throw new Error("Provider discovery configuration changed before admission");
      const currentRecord = await this.options.store.record<CatalogRecord>(RECORD_KIND, projectId);
      if (currentRecord?.value.state === "probing") return;
      if (
        !force &&
        currentRecord?.value.state === "verified" &&
        currentRecord.value.fingerprint === identity.fingerprint &&
        Date.parse(currentRecord.value.expiresAt) > this.now()
      ) {
        this.publish(projectId, currentRecord.value.entries);
        return;
      }
      const projectUid = identity.project.metadata.uid;
      if (!projectUid) throw new Error("Provider discovery requires a Project UID");
      runId = randomUUID();
      const claim: Extract<CatalogRecord, { state: "probing" }> = {
        state: "probing",
        fingerprint: identity.fingerprint,
        projectUid,
        runId,
        name: ProviderProbe.resourceName(runId),
        startedAt: new Date(this.now()).toISOString(),
        receipts: {},
        knownProviders:
          currentRecord?.value.fingerprint === identity.fingerprint &&
          (currentRecord.value.state === "verified" || currentRecord.value.state === "failed")
            ? knownProviders(currentRecord.value.entries ?? [])
            : [],
      };
      const started = await this.put(
        projectId,
        claim,
        (current) => current?.value.state !== "probing",
      );
      if (!started) return;
      this.scheduleStaleSweep(projectId, claim);
      const result: ProviderProbeResult = await this.probe.run({
        project: identity.project,
        profile: identity.profile,
        runId,
        onResourceCreated: async (kind, uid) => {
          const current = await this.options.store.record<CatalogRecord>(RECORD_KIND, projectId);
          if (current?.value.state !== "probing" || current.value.runId !== runId)
            throw new Error("Provider probe run was replaced");
          const updated = await this.put(
            projectId,
            {
              ...current.value,
              receipts: {
                ...current.value.receipts,
                ...(kind === "Pod" ? { podUid: uid } : { serviceUid: uid }),
              },
            },
            (latest) => latest?.value.state === "probing" && latest.value.runId === runId,
          );
          if (!updated) throw new Error("Provider probe run was replaced");
        },
      });
      const publishedProject = (await this.options.store.projects()).find(
        (row) =>
          row.metadata.name === projectId && row.metadata.uid === identity.project.metadata.uid,
      );
      if (
        !publishedProject ||
        (await this.identity(publishedProject)).fingerprint !== identity.fingerprint
      )
        throw new Error("Provider discovery configuration changed");
      const published = await this.put(
        projectId,
        {
          state: "verified",
          fingerprint: identity.fingerprint,
          entries: result.entries,
          fetchedAt: result.fetchedAt,
          expiresAt: new Date(this.now() + VERIFIED_TTL_MS).toISOString(),
        },
        (current) => current?.value.state === "probing" && current.value.runId === runId,
      );
      if (published) {
        this.recordVersions.set(projectId, published.version);
        const staleTimer = this.staleSweeps.get(projectId);
        if (staleTimer) clearTimeout(staleTimer);
        this.staleSweeps.delete(projectId);
        const timer = this.retries.get(projectId);
        if (timer) clearTimeout(timer);
        this.retries.delete(projectId);
        this.publish(projectId, result.entries);
      }
    } catch (error) {
      // Never persist provider stderr, HTTP bodies, Kubernetes error objects or Secret values.
      // A cleanup failure leaves the run record and receipts in place for a
      // bounded, ownership-checked stale sweep instead of hiding a live Pod.
      if (error instanceof ProviderProbeCleanupError) return;
      if (!runId) {
        if (identity.project.metadata.uid)
          this.scheduleRetry(projectId, identity.project.metadata.uid);
        return;
      }
      const currentRun = await this.options.store.record<CatalogRecord>(RECORD_KIND, projectId);
      const priorProviders =
        currentRun?.value.state === "probing" && currentRun.value.runId === runId
          ? (currentRun.value.knownProviders ?? [])
          : [];
      const failed = await this.put(
        projectId,
        {
          state: "failed",
          fingerprint: identity.fingerprint,
          code: "probe_failed",
          retryAt: new Date(this.now() + RETRY_DELAY_MS).toISOString(),
          entries: failedEntries(priorProviders, "failed"),
        },
        (current) => current?.value.state === "probing" && current.value.runId === runId,
      ).catch(() => undefined);
      if (failed) {
        this.recordVersions.set(projectId, failed.version);
        const staleTimer = this.staleSweeps.get(projectId);
        if (staleTimer) clearTimeout(staleTimer);
        this.staleSweeps.delete(projectId);
        this.publish(projectId, failed.value.state === "failed" ? failed.value.entries : []);
        if (identity.project.metadata.uid)
          this.scheduleRetry(projectId, identity.project.metadata.uid);
      }
    } finally {
      release();
    }
  }

  private async put(
    id: string,
    value: CatalogRecord,
    allowed: (current: ControlRecord<CatalogRecord> | undefined) => boolean,
  ): Promise<ControlRecord<CatalogRecord> | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.options.store.record<CatalogRecord>(RECORD_KIND, id);
      if (!allowed(current)) return undefined;
      try {
        return current
          ? await this.options.store.updateRecord({ ...current, value })
          : await this.options.store.createRecord({ kind: RECORD_KIND, id, value });
      } catch (error) {
        if (statusCode(error) !== 409 || attempt === 2) throw error;
      }
    }
    throw new Error("Provider catalog record update failed");
  }
}
