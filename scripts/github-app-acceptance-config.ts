import { z } from "zod";

/** Private operator inputs; never serialize this configuration into public evidence. */
export const GitHubAppAcceptanceConfigSchema = z
  .object({
    context: z.string().min(1),
    namespace: z.string().min(1),
    workspace: z.string().min(1),
    forceRenewal: z.literal(true),
    timeoutSeconds: z.number().int().min(30).max(600).default(240),
    privateWrite: z
      .object({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/) })
      .strict()
      .optional(),
    revokeNewlyMintedToken: z.boolean().default(false),
    suspendAfter: z.boolean().default(false),
  })
  .strict();
