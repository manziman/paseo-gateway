import { z } from "zod";

/** Private operator selection for the isolated local protocol acceptance fixture. */
export const ProtocolLiveConfigSchema = z
  .object({
    context: z.literal("docker-desktop"),
    namespace: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    identitySecret: z.string().default("paseo-identity"),
    tls: z.object({ caFile: z.string().min(1), serverName: z.string().min(1) }).strict(),
  })
  .strict();
