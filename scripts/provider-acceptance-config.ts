import { z } from "zod";

/** Operator input only: reports must never serialize this configuration. */
export const ProviderAcceptanceConfigSchema = z
  .object({
    context: z.string().min(1),
    namespace: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    identitySecret: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .default("paseo-identity"),
    tls: z
      .object({ caFile: z.string().min(1), serverName: z.string().min(1) })
      .strict()
      .optional(),
    replaceGateway: z.boolean().default(false),
    activeTurnGatewayRecovery: z.boolean().default(false),
    renewCodexAuthority: z.boolean().default(false),
    retainRunning: z.boolean().default(false),
    cases: z
      .array(
        z
          .object({
            provider: z.enum(["claude", "codex", "opencode"]),
            authentication: z.enum([
              "claude-setup-token",
              "codex-subscription-authority",
              "codex-api-key",
              "opencode-config",
            ]),
            project: z
              .string()
              .regex(/^[a-z0-9][a-z0-9-]*$/)
              .optional(),
            model: z.string().optional(),
            mode: z.string().optional(),
          })
          .strict()
          .refine(
            (entry) =>
              entry.provider === "claude"
                ? entry.authentication === "claude-setup-token"
                : entry.provider === "codex"
                  ? entry.authentication.startsWith("codex-")
                  : entry.authentication === "opencode-config",
            "Authentication case must match its provider",
          ),
      )
      .min(1),
  })
  .strict();
