import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

/** Access-only material; refresh tokens never cross this interface into workers. */
export const CodexAccessSchema = z
  .object({
    accessToken: z.string().min(1).max(32768),
    chatgptAccountId: z.string().min(1).max(512),
    chatgptPlanType: z.string().max(100).nullable(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type CodexAccess = z.infer<typeof CodexAccessSchema>;
export interface NativeCodexResult {
  authJson: string;
  access: CodexAccess;
}
export type NativeCodexRefresh = (authJson: string) => Promise<NativeCodexResult>;
type NativeStage =
  | "BootstrapInvalid"
  | "InitializationFailed"
  | "AuthLoadFailed"
  | "RefreshFailed"
  | "StateReadFailed"
  | "CredentialsUnchanged"
  | "ExportInvalid";
/** Fixed codes only; never copy native stderr, RPC errors or Zod input into status. */
export class NativeCodexFailure extends Error {
  constructor(readonly stage: NativeStage) {
    super(`CodexNativeAuthorityFailed:${stage}`);
  }
}

/** Validate the native export locally. Decoding claims does not authenticate a JWT. */
export function codexAccess(token: string, now = Date.now()): CodexAccess {
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
    );
    const parsed = z
      .object({
        exp: z.number().int().positive(),
        "https://api.openai.com/auth": z.object({
          chatgpt_account_id: z.string().min(1),
          chatgpt_plan_type: z.string().optional(),
        }),
      })
      .parse(claims);
    if (parsed.exp * 1000 <= now + 60_000) throw new Error();
    return CodexAccessSchema.parse({
      accessToken: token,
      chatgptAccountId: parsed["https://api.openai.com/auth"].chatgpt_account_id,
      chatgptPlanType: parsed["https://api.openai.com/auth"].chatgpt_plan_type ?? null,
      expiresAt: new Date(parsed.exp * 1000).toISOString(),
    });
  } catch {
    throw new Error("CodexAccessExportInvalidOrExpired");
  }
}

/**
 * Delegate OAuth entirely to pinned native Codex. A caller must hold the durable
 * broker lease before invoking this function; even a timeout may have rotated
 * the upstream refresh token, so a failed call is never automatically retried.
 */
export async function refreshWithNativeCodex(
  authJson: string,
  options: {
    executable?: string;
    timeoutMs?: number;
  } = {},
): Promise<NativeCodexResult> {
  const home = await mkdtemp(join(tmpdir(), "paseo-codex-authority-"));
  const authPath = join(home, "auth.json");
  let stage: NativeStage = "BootstrapInvalid";
  try {
    if (Buffer.byteLength(authJson) > 1024 * 1024) throw new Error();
    const shape: unknown = JSON.parse(authJson);
    const initial = z
      .object({
        auth_mode: z.literal("chatgpt"),
        tokens: z.object({ refresh_token: z.string().min(1), access_token: z.string().optional() }),
      })
      .parse(shape);
    await writeFile(authPath, authJson, { mode: 0o600 });
    stage = "InitializationFailed";
    const child = spawn(
      options.executable ?? "codex",
      ["-c", 'cli_auth_credentials_store="file"', "app-server", "--listen", "stdio://"],
      {
        env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform !== "win32",
      },
    );
    // The npm launcher creates a native child. Kill the isolated process group,
    // not just its JavaScript parent, before removing the private auth directory.
    const terminate = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* The group may already have exited. */
      }
    };
    const lines = createInterface({ input: child.stdout });
    let sequence = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: () => void }>();
    const abort = () => {
      for (const request of pending.values()) request.reject();
      pending.clear();
      terminate();
    };
    const timeout = setTimeout(abort, options.timeoutMs ?? 30_000);
    child.on("error", abort);
    child.stdin.on("error", abort);
    child.on("exit", abort);
    lines.on("line", (line) => {
      try {
        const message: unknown = JSON.parse(line);
        if (
          !message ||
          typeof message !== "object" ||
          !("id" in message) ||
          typeof message.id !== "number"
        )
          return;
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if ("error" in message) request.reject();
        else if ("result" in message) request.resolve(message.result);
        else request.reject();
      } catch {
        abort();
      }
    });
    const request = (method: string, params: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject: () => reject(new Error("CodexNativeAuthorityFailed")) });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    try {
      await request("initialize", {
        clientInfo: { name: "paseo_gateway_authority", version: "1" },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      // A cold AuthManager's guarded reload treats first load as a changed source
      // and skips refresh. Warm its cache before explicitly requesting renewal.
      stage = "AuthLoadFailed";
      z.object({ authMethod: z.literal("chatgpt") }).parse(
        await request("getAuthStatus", { includeToken: false, refreshToken: false }),
      );
      stage = "RefreshFailed";
      const exported = z
        .object({ authMethod: z.literal("chatgpt"), authToken: z.string().min(1) })
        .parse(
          await request("getAuthStatus", {
            includeToken: true,
            refreshToken: true,
          }),
        );
      stage = "StateReadFailed";
      const updatedAuth = await readFile(authPath, "utf8");
      const updated = z
        .object({ tokens: z.object({ refresh_token: z.string() }) })
        .parse(JSON.parse(updatedAuth));
      stage = "CredentialsUnchanged";
      if (
        exported.authToken === initial.tokens.access_token &&
        updated.tokens.refresh_token === initial.tokens.refresh_token
      )
        throw new Error("CodexRefreshDidNotReplaceCredentials");
      stage = "ExportInvalid";
      const access = codexAccess(exported.authToken);
      return { authJson: updatedAuth, access };
    } finally {
      clearTimeout(timeout);
      lines.close();
      terminate();
      // Wait until the native writer has stopped before erasing the private directory.
      if (child.pid && child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  } catch {
    throw new NativeCodexFailure(stage);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
