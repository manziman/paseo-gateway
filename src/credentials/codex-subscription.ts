import { createHash, randomUUID } from "node:crypto";
import type { V1Secret } from "@kubernetes/client-node";
import { API_GROUP, type CredentialProfile, CredentialProfileSchema } from "../domain.js";
import {
  CodexAccessSchema,
  NativeCodexFailure,
  type NativeCodexRefresh,
  refreshWithNativeCodex,
} from "./codex-native.js";
import type { BrokerSecretStore, BrokerStatus } from "./github-app.js";

const field = (key: string) => `${API_GROUP}/codex-${key}`;
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
const ACCESS_KEY = "paseo-access.json";
const LEASE_MS = 60_000;
const RENEW_EARLY_MS = 5 * 60_000;

/**
 * A durable refresh-intent fences native OAuth rotation. Expiry of an unfinished
 * intent requires reauthentication, because an external rotation and a Kubernetes
 * Secret write cannot be one transaction. Never retry an ambiguous refresh token.
 */
export class CodexSubscriptionBroker {
  private readonly now: () => number;
  private readonly native: NativeCodexRefresh;
  constructor(
    private readonly store: BrokerSecretStore,
    options: {
      now?: () => number;
      native?: NativeCodexRefresh;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.native = options.native ?? refreshWithNativeCodex;
  }

  async reconcile(profiles: CredentialProfile[]): Promise<BrokerStatus[]> {
    const result: BrokerStatus[] = [];
    for (const input of profiles) {
      if (!input.spec.codexSubscription) continue;
      try {
        result.push(await this.renew(CredentialProfileSchema.parse(input)));
      } catch {
        result.push({
          profileName: input.metadata.name,
          state: "Failed",
          reason: "CodexAuthorityUnavailable",
        });
      }
    }
    return result;
  }

  private async renew(profile: CredentialProfile): Promise<BrokerStatus> {
    const config = profile.spec.codexSubscription;
    if (!config) throw new Error();
    const status = (state: BrokerStatus["state"], reason: string): BrokerStatus => ({
      profileName: profile.metadata.name,
      state,
      reason,
    });
    const owner = `${profile.metadata.namespace}/${profile.metadata.name}/${profile.metadata.uid ?? ""}`;
    const authority = await this.store.readSecret(config.authSecretRef.name);
    const encoded = authority?.data?.[config.authSecretRef.key];
    if (!authority || !encoded || !authority.metadata)
      return status("Failed", "CodexBootstrapMissing");
    const annotations = authority.metadata.annotations ?? {};
    if (annotations[field("owner")] && annotations[field("owner")] !== owner)
      return status("Failed", "CodexAuthorityAlreadyOwned");
    const binding = fingerprint(JSON.stringify({ config, uid: authority.metadata.uid, owner }));
    const output = await this.store.readSecret(config.outputSecretName);
    if (output && output.metadata?.annotations?.[field("owner")] !== owner)
      return status("Failed", "CodexOutputAlreadyOwned");
    const authDigest = fingerprint(encoded);
    let refreshDigest: string;
    try {
      const nativeState: unknown = JSON.parse(Buffer.from(encoded, "base64").toString());
      if (
        !nativeState ||
        typeof nativeState !== "object" ||
        !("tokens" in nativeState) ||
        !nativeState.tokens ||
        typeof nativeState.tokens !== "object" ||
        !("refresh_token" in nativeState.tokens) ||
        typeof nativeState.tokens.refresh_token !== "string" ||
        !nativeState.tokens.refresh_token
      )
        throw new Error();
      refreshDigest = fingerprint(nativeState.tokens.refresh_token);
    } catch {
      return status("Failed", "CodexBootstrapInvalid");
    }
    // A new dedicated bootstrap can recover an uncertain rotation. Unchanged
    // material must remain fenced even across lease expiry and gateway restart.
    if (annotations[field("intent")] === refreshDigest) {
      if (Date.parse(annotations[field("lease-until")] ?? "") > this.now())
        return status("Busy", "CodexRefreshInProgress");
      await this.invalidateOutput(config.outputSecretName, output);
      return status("Failed", "CodexReauthenticationRequired");
    }
    const cached = authority.data?.[ACCESS_KEY];
    if (
      cached &&
      annotations[field("binding")] === binding &&
      annotations[field("auth-digest")] === authDigest
    ) {
      try {
        const access = CodexAccessSchema.parse(
          JSON.parse(Buffer.from(cached, "base64").toString()),
        );
        if (Date.parse(access.expiresAt) > this.now() + RENEW_EARLY_MS) {
          return (await this.publish(profile, authority, cached, binding, owner))
            ? status("Ready", "CodexAccessCurrent")
            : status("Busy", "CodexPublishConflict");
        }
      } catch {
        /* Invalid cached access must be renewed by the authority. */
      }
    }
    if (
      (output?.metadata?.annotations?.[field("binding")] !== binding ||
        annotations[field("auth-digest")] !== authDigest) &&
      !(await this.invalidateOutput(config.outputSecretName, output))
    )
      return status("Busy", "CodexOutputConflict");
    const lease = randomUUID();
    const claimed = structuredClone(authority);
    claimed.metadata = {
      ...claimed.metadata,
      annotations: {
        ...annotations,
        [field("owner")]: owner,
        [field("intent")]: refreshDigest,
        [field("lease")]: lease,
        [field("lease-until")]: new Date(this.now() + LEASE_MS).toISOString(),
      },
    };
    if (
      !(await this.store.compareAndSwapSecret(
        config.authSecretRef.name,
        authority.metadata.resourceVersion,
        claimed,
      ))
    )
      return status("Busy", "CodexLeaseConflict");
    let refreshed: Awaited<ReturnType<NativeCodexRefresh>>;
    try {
      refreshed = await this.native(Buffer.from(encoded, "base64").toString());
    } catch (error) {
      return status(
        "Failed",
        error instanceof NativeCodexFailure
          ? `CodexReauthenticationRequired:${error.stage}`
          : "CodexReauthenticationRequired",
      );
    }
    const latest = await this.store.readSecret(config.authSecretRef.name);
    if (
      !latest?.metadata ||
      latest.metadata.annotations?.[field("lease")] !== lease ||
      latest.data?.[config.authSecretRef.key] !== encoded ||
      Date.parse(latest.metadata.annotations[field("lease-until")] ?? "") <= this.now()
    )
      return status("Failed", "CodexRefreshCommitUncertain");
    const committed = structuredClone(latest);
    const newAuth = Buffer.from(refreshed.authJson).toString("base64");
    const access = CodexAccessSchema.parse(refreshed.access);
    if (Date.parse(access.expiresAt) <= this.now() + 60_000)
      return status("Failed", "CodexAccessExpired");
    const accessData = Buffer.from(JSON.stringify(access)).toString("base64");
    committed.data = {
      ...committed.data,
      [config.authSecretRef.key]: newAuth,
      [ACCESS_KEY]: accessData,
    };
    committed.metadata = {
      ...committed.metadata,
      annotations: {
        ...committed.metadata?.annotations,
        [field("binding")]: binding,
        [field("auth-digest")]: fingerprint(newAuth),
      },
    };
    for (const key of ["intent", "lease", "lease-until"])
      delete committed.metadata.annotations?.[field(key)];
    if (
      !(await this.store.compareAndSwapSecret(
        config.authSecretRef.name,
        latest.metadata.resourceVersion,
        committed,
      ))
    )
      return status("Failed", "CodexRefreshCommitUncertain");
    const durable = await this.store.readSecret(config.authSecretRef.name);
    if (!durable || !(await this.publish(profile, durable, accessData, binding, owner)))
      return status("Busy", "CodexPublishConflict");
    return status("Renewed", "CodexAccessRenewed");
  }

  private async invalidateOutput(name: string, secret: V1Secret | undefined): Promise<boolean> {
    if (!secret || secret.data?.["access.json"] === "") return true;
    return this.store.compareAndSwapSecret(name, secret.metadata?.resourceVersion, {
      ...secret,
      data: { "access.json": "" },
    });
  }

  private async publish(
    profile: CredentialProfile,
    authority: V1Secret,
    encoded: string,
    binding: string,
    owner: string,
  ): Promise<boolean> {
    const config = profile.spec.codexSubscription;
    if (
      !config ||
      authority.metadata?.annotations?.[field("binding")] !== binding ||
      authority.data?.[ACCESS_KEY] !== encoded ||
      fingerprint(authority.data?.[config.authSecretRef.key] ?? "") !==
        authority.metadata?.annotations?.[field("auth-digest")] ||
      authority.metadata.annotations[field("intent")]
    )
      return false;
    const current = await this.store.readSecret(config.outputSecretName);
    if (current && current.metadata?.annotations?.[field("owner")] !== owner) return false;
    if (
      current?.data?.["access.json"] === encoded &&
      current.metadata?.annotations?.[field("binding")] === binding
    )
      return true;
    // Re-read after output lookup so an operator bootstrap change fences this publication.
    const latest = await this.store.readSecret(config.authSecretRef.name);
    if (latest?.metadata?.resourceVersion !== authority.metadata?.resourceVersion) return false;
    return this.store.compareAndSwapSecret(
      config.outputSecretName,
      current?.metadata?.resourceVersion,
      {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: {
          name: config.outputSecretName,
          namespace: profile.metadata.namespace,
          resourceVersion: current?.metadata?.resourceVersion,
          annotations: { [field("owner")]: owner, [field("binding")]: binding },
        },
        data: { "access.json": encoded },
      },
    );
  }
}
