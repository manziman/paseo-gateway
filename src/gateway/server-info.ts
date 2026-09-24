import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { GatewayPrincipal } from "./auth.js";

/** Only implemented behavior may be advertised; unknown/unsupported overrides fail startup. */
export const ServerInfoConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).default("Paseo Gateway"),
});
export type ServerInfoConfig = z.input<typeof ServerInfoConfigSchema>;

export function buildServerInfo(
  serverId: string,
  input: ServerInfoConfig = {},
  principal: GatewayPrincipal = { kind: "owner" },
  creationLifecycle = false,
) {
  const config = ServerInfoConfigSchema.parse(input);
  if (!serverId.trim()) throw new Error("A retained server ID is required");
  return ServerInfoStatusPayloadSchema.parse({
    status: "server_info",
    serverId,
    hostname: `${config.name} (independent)`,
    version: "0.9.1",
    permissions:
      principal.kind === "owner"
        ? ["daemon.read", "workspace.read", "workspace.write", "workspace.manage"]
        : ["workspace.read", "workspace.write", "workspace.manage"],
    capabilities: {
      voice: {
        dictation: { enabled: false, reason: "Not supported by this gateway" },
        voice: { enabled: false, reason: "Not supported by this gateway" },
      },
    },
    features: {
      providersSnapshot: true,
      providersSnapshotCwd: true,
      directorySync: true,
      workspaceMultiplicity: true,
      agentThinkingUpdate: true,
      daemonStatusRpc: true,
      workspaceLabels: false,
      ...(creationLifecycle ? { creationLifecycle: true } : {}),
    },
  });
}
