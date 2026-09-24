import { createRequire } from "node:module";
import { z } from "zod";

const packageMetadata = z
  .object({ version: z.string() })
  .parse(createRequire(import.meta.url)("../../package.json"));

/** Describe this gateway process, rather than reporting a workspace daemon's PID as the host. */
export function gatewayRuntime(serverId: string, listen: string) {
  return {
    serverId,
    version: packageMetadata.version,
    pid: process.pid,
    nodePath: process.execPath,
    startedAt: new Date().toISOString(),
    listen,
  };
}
export type GatewayRuntime = ReturnType<typeof gatewayRuntime>;
