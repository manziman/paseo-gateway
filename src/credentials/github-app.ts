import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import type { V1Secret } from "@kubernetes/client-node";
import { API_GROUP, type CredentialProfile, CredentialProfileSchema } from "../domain.js";

export interface BrokerSecretStore {
  readSecret(name: string): Promise<V1Secret | undefined>;
  /** Atomic create when version is undefined; otherwise replace only the matching version. */
  compareAndSwapSecret(
    name: string,
    expectedResourceVersion: string | undefined,
    secret: V1Secret,
  ): Promise<boolean>;
}
export interface BrokerStatus {
  profileName: string;
  state: "Ready" | "Renewed" | "Busy" | "Backoff" | "Failed";
  reason: string;
  nextAttempt?: string;
}
interface BrokerOptions {
  fetch?: typeof fetch;
  now?: () => number;
  ownerId?: string;
}
const prefix = `${API_GROUP}/broker-`;
const field = (key: string) => `${prefix}${key}`;
const RENEW_EARLY_MS = 5 * 60_000;
const LOCK_MS = 60_000;
class BrokerFailure extends Error {}

/** The gateway is the only minting authority; workspace Pods receive access tokens only. */
export class GitHubAppBroker {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly ownerId: string;
  constructor(
    private readonly store: BrokerSecretStore,
    options: BrokerOptions = {},
  ) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.ownerId = options.ownerId ?? randomUUID();
  }

  async reconcile(profiles: CredentialProfile[]): Promise<BrokerStatus[]> {
    const statuses: BrokerStatus[] = [];
    for (const input of profiles) {
      if (!input.spec.git?.githubApp) continue;
      try {
        statuses.push(await this.renew(CredentialProfileSchema.parse(input)));
      } catch {
        statuses.push({
          profileName: input.metadata.name,
          state: "Failed",
          reason: "BrokerUnavailable",
        });
      }
    }
    return statuses;
  }

  private async renew(profile: CredentialProfile): Promise<BrokerStatus> {
    const app = profile.spec.git?.githubApp;
    if (!app) throw new Error("Expected GitHub App configuration");
    const status = (
      state: BrokerStatus["state"],
      reason: string,
      nextAttempt?: string,
    ): BrokerStatus => ({
      profileName: profile.metadata.name,
      state,
      reason,
      ...(nextAttempt ? { nextAttempt } : {}),
    });
    const now = this.now();
    const identity = `${profile.metadata.namespace}/${profile.metadata.name}/${profile.metadata.uid ?? ""}`;
    const fingerprint = createHash("sha256").update(JSON.stringify(app)).digest("hex");
    const current = await this.store.readSecret(app.outputSecretName);
    const annotations = current?.metadata?.annotations ?? {};
    // Never adopt or overwrite an operator-managed Secret, including an App private key.
    if (current && annotations[field("profile")] !== identity)
      return status("Failed", "OutputSecretAlreadyOwned");
    if (Date.parse(annotations[field("lock-until")] ?? "") > now)
      return status("Busy", "RenewalInProgress");
    const expires = Date.parse(annotations[field("expires-at")] ?? "");
    const matches = annotations[field("configuration")] === fingerprint;
    if (matches && current?.data?.token && expires > now + RENEW_EARLY_MS)
      return status("Ready", "TokenCurrent", new Date(expires - RENEW_EARLY_MS).toISOString());
    const nextAttempt = annotations[field("next-attempt")];
    if (matches && nextAttempt && Date.parse(nextAttempt) > now)
      return status("Backoff", annotations[field("error")] ?? "RenewalBackoff", nextAttempt);
    const lockId = `${this.ownerId}/${randomUUID()}`;
    const claimed: V1Secret = {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: {
        name: app.outputSecretName,
        namespace: profile.metadata.namespace,
        resourceVersion: current?.metadata?.resourceVersion,
        annotations: {
          ...annotations,
          [field("profile")]: identity,
          [field("configuration")]: fingerprint,
          [field("lock-id")]: lockId,
          [field("lock-until")]: new Date(now + LOCK_MS).toISOString(),
        },
      },
      // Keep an empty key when invalidating existing scope: removing a required projected
      // key would make kubelet retain the previous successful volume contents.
      data: matches ? (current?.data ?? {}) : current ? { token: "" } : {},
    };
    if (
      !(await this.store.compareAndSwapSecret(
        app.outputSecretName,
        current?.metadata?.resourceVersion,
        claimed,
      ))
    )
      return status("Busy", "RenewalConflict");
    let token: string | undefined;
    let expiry: string | undefined;
    let failure: string | undefined;
    try {
      const keySecret = await this.store.readSecret(app.privateKeySecretRef.name);
      const encoded = keySecret?.data?.[app.privateKeySecretRef.key];
      if (!encoded) throw new BrokerFailure("PrivateKeyUnavailable");
      let jwt: string;
      try {
        const key = createPrivateKey(Buffer.from(encoded, "base64"));
        if (key.asymmetricKeyType !== "rsa") throw new Error("RS256 requires RSA");
        const head = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
          "base64url",
        );
        const body = Buffer.from(
          JSON.stringify({
            iat: Math.floor(now / 1000) - 60,
            exp: Math.floor(now / 1000) + 540,
            iss: String(app.appId),
          }),
        ).toString("base64url");
        const message = `${head}.${body}`;
        jwt = `${message}.${sign("RSA-SHA256", Buffer.from(message), key).toString("base64url")}`;
      } catch {
        throw new BrokerFailure("PrivateKeyInvalid");
      }
      const lease = await this.store.readSecret(app.outputSecretName);
      if (
        lease?.metadata?.annotations?.[field("lock-id")] !== lockId ||
        Date.parse(lease.metadata.annotations[field("lock-until")] ?? "") <= this.now() + 15_000
      )
        throw new BrokerFailure("RenewalLeaseLost");
      const response = await this.request(
        `https://api.github.com/app/installations/${app.installationId}/access_tokens`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2026-03-10",
          },
          body: JSON.stringify({
            repositories: app.repositories.map((repo) => repo.split("/")[1]),
            permissions: { contents: "write", pull_requests: "write" },
          }),
        },
      );
      if (!response.ok) throw new BrokerFailure(`GitHubHTTP${response.status}`);
      const result: unknown = await response.json();
      if (!result || typeof result !== "object") throw new BrokerFailure("InvalidGitHubResponse");
      const payload = result as Record<string, unknown>;
      if (
        typeof payload.token !== "string" ||
        !payload.token ||
        payload.token.length > 16384 ||
        /\s/.test(payload.token) ||
        typeof payload.expires_at !== "string" ||
        !Number.isFinite(Date.parse(payload.expires_at)) ||
        Date.parse(payload.expires_at) <= this.now() + RENEW_EARLY_MS
      )
        throw new BrokerFailure("InvalidGitHubResponse");
      const allowed = new Set(app.repositories.map((repo) => repo.toLowerCase()));
      if (
        !Array.isArray(payload.repositories) ||
        !payload.repositories.length ||
        payload.repositories.some(
          (repo: unknown) =>
            !repo ||
            typeof repo !== "object" ||
            !("full_name" in repo) ||
            typeof repo.full_name !== "string" ||
            !allowed.has(repo.full_name.toLowerCase()),
        )
      )
        throw new BrokerFailure("RepositoryScopeMismatch");
      token = payload.token;
      expiry = payload.expires_at;
    } catch (error) {
      failure = error instanceof BrokerFailure ? error.message : "RenewalRequestFailed";
    }
    const latest = await this.store.readSecret(app.outputSecretName);
    if (
      !latest ||
      latest.metadata?.annotations?.[field("lock-id")] !== lockId ||
      Date.parse(latest.metadata.annotations[field("lock-until")] ?? "") <= this.now()
    )
      return status("Busy", "RenewalLeaseLost");
    const updated = structuredClone(latest);
    if (!updated.metadata?.annotations) throw new Error("Missing renewal lease");
    const values = updated.metadata.annotations;
    delete values[field("lock-id")];
    delete values[field("lock-until")];
    if (token && expiry) {
      updated.data = { token: Buffer.from(token).toString("base64") };
      values[field("expires-at")] = expiry;
      delete values[field("failures")];
      delete values[field("error")];
      delete values[field("next-attempt")];
    } else {
      const failures = Math.min(10, (Number(values[field("failures")]) || 0) + 1);
      values[field("failures")] = String(failures);
      values[field("error")] = failure ?? "RenewalFailed";
      values[field("next-attempt")] = new Date(
        this.now() + Math.min(300_000, 5_000 * 2 ** (failures - 1)),
      ).toISOString();
    }
    if (
      !(await this.store.compareAndSwapSecret(
        app.outputSecretName,
        latest.metadata.resourceVersion,
        updated,
      ))
    )
      return status("Busy", "RenewalConflict");
    return token
      ? status(
          "Renewed",
          "TokenRenewed",
          new Date(Date.parse(expiry ?? "") - RENEW_EARLY_MS).toISOString(),
        )
      : status("Backoff", failure ?? "RenewalFailed", values[field("next-attempt")]);
  }
}
