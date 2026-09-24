import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { WSHelloMessage } from "@getpaseo/protocol/messages";
import { expandProviderSnapshot } from "@getpaseo/protocol/provider-snapshot-codec";
import { type RuntimeConfig, resourceName } from "../controller/resources.js";
import { type CredentialProfile, type Project, type Workspace, workspacePath } from "../domain.js";
import type { Store } from "../kubernetes/store.js";
import { statusCode } from "../kubernetes/store.js";
import { type Backend, PaseoBackend } from "./backend.js";
import { isOwnedProviderProbe, providerProbeResources } from "./provider-probe-resources.js";

const MAX_PROBE_MS = 240_000;
const MAX_SNAPSHOT_BYTES = 500_000;
const PROBE_HELLO: WSHelloMessage = {
  type: "hello",
  clientId: "gateway-provider-probe",
  clientType: "cli",
  protocolVersion: 1,
};

export interface ProviderProbeResult {
  entries: ProviderSnapshotEntry[];
  fetchedAt: string;
}

export interface ProviderProbeReceipts {
  podUid?: string;
  serviceUid?: string;
}

export class ProviderProbeCleanupError extends Error {}

/** Never persist arbitrary provider errors, diagnostics, SVG or metadata. */
export function publicProviderEntries(
  entries: readonly ProviderSnapshotEntry[],
): ProviderSnapshotEntry[] {
  if (entries.length > 32) throw new Error("Provider catalog exceeds the supported provider count");
  const count = <T>(items: readonly T[], maximum: number): readonly T[] => {
    if (items.length > maximum) throw new Error("Provider catalog exceeds its bounded entry count");
    return items;
  };
  const bounded = (value: string, length: number) => {
    if (value.length > length) throw new Error("Provider catalog identifier or label is too long");
    return value;
  };
  return entries.map((entry) => ({
    provider: bounded(entry.provider, 128),
    status: entry.status,
    enabled: entry.enabled,
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.label ? { label: bounded(entry.label, 200) } : {}),
    ...(entry.status === "ready"
      ? {
          models: count(entry.models ?? [], 1_000).map((model) => ({
            provider: bounded(model.provider, 128),
            id: bounded(model.id, 256),
            label: bounded(model.label, 200),
            ...(model.description ? { description: bounded(model.description, 500) } : {}),
            ...(model.aliases
              ? { aliases: count(model.aliases, 64).map((alias) => bounded(alias, 256)) }
              : {}),
            ...(model.isDefault !== undefined ? { isDefault: model.isDefault } : {}),
            ...(model.isSelectable !== undefined ? { isSelectable: model.isSelectable } : {}),
            ...(model.contextWindowMaxTokens !== undefined
              ? { contextWindowMaxTokens: model.contextWindowMaxTokens }
              : {}),
            ...(model.thinkingOptions
              ? {
                  thinkingOptions: count(model.thinkingOptions, 64).map((option) => ({
                    id: bounded(option.id, 128),
                    label: bounded(option.label, 200),
                    ...(option.description
                      ? { description: bounded(option.description, 500) }
                      : {}),
                    ...(option.isDefault !== undefined ? { isDefault: option.isDefault } : {}),
                  })),
                }
              : {}),
            ...(model.defaultThinkingOptionId
              ? { defaultThinkingOptionId: bounded(model.defaultThinkingOptionId, 128) }
              : {}),
          })),
          ...(entry.modes
            ? {
                modes: count(entry.modes, 128).map((mode) => ({
                  id: bounded(mode.id, 128),
                  label: bounded(mode.label, 200),
                  ...(mode.description ? { description: bounded(mode.description, 500) } : {}),
                  ...(mode.icon ? { icon: bounded(mode.icon, 100) } : {}),
                  ...(mode.colorTier ? { colorTier: bounded(mode.colorTier, 100) } : {}),
                })),
              }
            : {}),
          ...(entry.defaultModeId !== undefined
            ? {
                defaultModeId:
                  entry.defaultModeId === null ? null : bounded(entry.defaultModeId, 128),
              }
            : {}),
        }
      : { error: `Provider catalog ${entry.status}` }),
  }));
}

export interface ProviderProbeOptions {
  store: Store;
  namespace: string;
  backendPassword: string;
  backendSecure: boolean;
  runtime: RuntimeConfig;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  backendFactory?: (url: string) => Backend;
  maxProbeMs?: number;
}

export class ProviderProbe {
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: ProviderProbeOptions) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((ms) => delay(ms));
  }

  static resourceName(runId: string): string {
    const workspace: Workspace = {
      apiVersion: "paseo-gateway.manziman.github.io/v1alpha1",
      kind: "PaseoWorkspace",
      metadata: {
        name: `catalog-${runId.replace(/-/g, "").slice(0, 24)}`,
        namespace: "probe",
        uid: runId,
      },
      spec: {
        projectRef: "probe",
        credentialProfile: "probe",
        displayName: "probe",
        revision: "HEAD",
        residency: "Running",
      },
    };
    return resourceName(workspace);
  }

  async run(input: {
    project: Project;
    profile: CredentialProfile;
    runId?: string;
    onResourceCreated?: (kind: "Pod" | "Service", uid: string) => Promise<void>;
  }): Promise<ProviderProbeResult> {
    const runId = input.runId ?? randomUUID();
    const resources = providerProbeResources({
      project: input.project,
      profile: input.profile,
      runId,
      config: this.options.runtime,
    });
    const name = resources.name;
    const projectUid = input.project.metadata.uid;
    if (!projectUid) throw new Error("Provider probe requires a Project UID");
    const deadline = this.now() + (this.options.maxProbeMs ?? MAX_PROBE_MS);
    let backend: Backend | undefined;
    let result: ProviderProbeResult | undefined;
    let failure: unknown;
    const receipts: ProviderProbeReceipts = {};
    try {
      const service = await this.options.store.create(resources.service);
      if (!isOwnedProviderProbe({ object: service, name, projectUid, runId }))
        throw new Error("Provider probe Service creation returned an invalid identity");
      if (!service.metadata?.uid) throw new Error("Provider probe Service UID is unavailable");
      receipts.serviceUid = service.metadata.uid;
      await input.onResourceCreated?.("Service", receipts.serviceUid);
      const pod = await this.options.store.create(resources.pod);
      if (!isOwnedProviderProbe({ object: pod, name, projectUid, runId }))
        throw new Error("Provider probe Pod creation returned an invalid identity");
      if (!pod.metadata?.uid) throw new Error("Provider probe Pod UID is unavailable");
      receipts.podUid = pod.metadata.uid;
      await input.onResourceCreated?.("Pod", receipts.podUid);
      await this.waitForPod(name, projectUid, runId, receipts.podUid, deadline);
      const url = `${this.options.backendSecure ? "wss" : "ws"}://${name}.${this.options.namespace}.svc:6767/ws`;
      backend =
        this.options.backendFactory?.(url) ??
        new PaseoBackend(
          url,
          this.options.backendPassword,
          PROBE_HELLO,
          () => {},
          () => {},
          () => {},
          20_000,
        );
      await backend.connect();
      const cwd = workspacePath(`catalog-${runId.replace(/-/g, "").slice(0, 24)}`);
      const opened = await backend.request({
        type: "open_project_request",
        requestId: randomUUID(),
        cwd,
      });
      if (opened.type !== "open_project_response" || !opened.payload.workspace)
        throw new Error("Provider probe daemon registration failed");
      const refresh = await backend.request({
        type: "refresh_providers_snapshot_request",
        requestId: randomUUID(),
        cwd,
      });
      if (refresh.type !== "refresh_providers_snapshot_response" || !refresh.payload.acknowledged)
        throw new Error("Provider probe catalog refresh was not acknowledged");
      while (this.now() < deadline) {
        const reply = await backend.request({
          type: "get_providers_snapshot_request",
          requestId: randomUUID(),
          cwd,
        });
        if (reply.type !== "get_providers_snapshot_response")
          throw new Error("Provider probe catalog response was invalid");
        // The pinned DaemonClient advertises compact snapshots by default.
        // Backend.request exposes the raw wire frame before SDK expansion, so
        // entries can be empty even when compactSnapshot contains the catalog.
        const entries = publicProviderEntries(
          reply.payload.compactSnapshot
            ? expandProviderSnapshot(reply.payload.compactSnapshot)
            : reply.payload.entries,
        );
        if (Buffer.byteLength(JSON.stringify(entries)) > MAX_SNAPSHOT_BYTES)
          throw new Error("Provider catalog exceeds the bounded storage budget");
        if (entries.length > 0 && entries.every((entry) => entry.status !== "loading")) {
          await this.assertPodIdentity(name, projectUid, runId, receipts.podUid);
          result = { entries, fetchedAt: new Date(this.now()).toISOString() };
          break;
        }
        await this.wait(1500);
      }
      if (!result) throw new Error("Provider probe timed out before catalog discovery completed");
    } catch (error) {
      failure = error;
    }
    await backend?.close().catch(() => {});
    try {
      await this.cleanup(name, projectUid, runId, receipts);
    } catch {
      throw new ProviderProbeCleanupError("Provider probe cleanup is incomplete");
    }
    if (failure) throw failure;
    if (!result) throw new Error("Provider probe result is unavailable");
    return result;
  }

  private async assertPodIdentity(name: string, projectUid: string, runId: string, podUid: string) {
    const pod = await this.options.store.get("Pod", name);
    if (!isOwnedProviderProbe({ object: pod, name, projectUid, runId, resourceUid: podUid }))
      throw new Error("Provider probe Pod identity changed");
  }

  private async waitForPod(
    name: string,
    projectUid: string,
    runId: string,
    podUid: string,
    deadline: number,
  ) {
    while (this.now() < deadline) {
      const pod = await this.options.store.get("Pod", name);
      if (pod && pod.kind === "Pod" && pod.spec && "containers" in pod.spec) {
        if (!isOwnedProviderProbe({ object: pod, name, projectUid, runId, resourceUid: podUid }))
          throw new Error("Provider probe Pod ownership changed");
        if (pod.status && "phase" in pod.status && pod.status.phase === "Failed")
          throw new Error("Provider probe Pod failed");
        if (
          pod.status &&
          "conditions" in pod.status &&
          pod.status.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          )
        )
          return;
      }
      await this.wait(1000);
    }
    throw new Error("Provider probe Pod readiness timed out");
  }

  /** Also called on gateway restart for persisted in-flight run IDs. */
  async cleanup(
    name: string,
    projectUid: string,
    runId: string,
    receipts?: ProviderProbeReceipts,
    recoverMissingReceipts = false,
  ): Promise<void> {
    const [pod, service] = await Promise.all([
      this.options.store.get("Pod", name),
      this.options.store.get("Service", name),
    ]);
    const ownedPod =
      !!pod?.spec &&
      "containers" in pod.spec &&
      isOwnedProviderProbe({ object: pod, name, projectUid, runId });
    const ownedService =
      !!service?.spec &&
      "ports" in service.spec &&
      isOwnedProviderProbe({ object: service, name, projectUid, runId });
    const eligiblePod =
      ownedPod &&
      (!receipts ||
        receipts.podUid === pod?.metadata?.uid ||
        (recoverMissingReceipts && !receipts.podUid));
    const eligibleService =
      ownedService &&
      (!receipts ||
        receipts.serviceUid === service?.metadata?.uid ||
        (recoverMissingReceipts && !receipts.serviceUid));
    // A missing receipt is possible only after a process dies between the API
    // create and the durable receipt write. The run label and Project owner UID
    // still fence this object; callers may reclaim it only after run expiry.
    if (eligiblePod && pod?.metadata?.uid && !pod.metadata.deletionTimestamp)
      await this.options.store.deletePod(name, pod.metadata.uid).catch((error: unknown) => {
        if (statusCode(error) !== 404) throw error;
      });
    if (eligibleService && service?.metadata?.uid && !service.metadata.deletionTimestamp)
      await this.options.store.deleteService(name, service.metadata.uid).catch((error: unknown) => {
        if (statusCode(error) !== 404) throw error;
      });
    const expectedPod = eligiblePod && pod?.metadata?.uid;
    const expectedService = eligibleService && service?.metadata?.uid;
    if (!expectedPod && !expectedService) return;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const [currentPod, currentService] = await Promise.all([
        expectedPod ? this.options.store.get("Pod", name) : undefined,
        expectedService ? this.options.store.get("Service", name) : undefined,
      ]);
      if (
        (!expectedPod || currentPod?.metadata?.uid !== expectedPod) &&
        (!expectedService || currentService?.metadata?.uid !== expectedService)
      )
        return;
      await this.wait(500);
    }
    throw new ProviderProbeCleanupError("Provider probe resource deletion was not observed");
  }
}
