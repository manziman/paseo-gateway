import { execFileSync } from "node:child_process";
import { z } from "zod";
import { API_GROUP } from "../src/domain.js";
import { context, namespace } from "./local-config.js";

function kubectl(args: string[]): unknown {
  return JSON.parse(
    execFileSync(
      "kubectl",
      ["--context", context, "--request-timeout=10s", ...args, "-o", "json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    ),
  );
}

// Changing an API group creates new objects and UIDs; it cannot adopt the old PVCs.
// Block before changing the running gateway, while the old controller still owns its records.
const definitions = z
  .object({
    items: z.array(
      z.object({
        spec: z.object({
          group: z.string(),
          names: z.object({ kind: z.string(), plural: z.string() }),
        }),
      }),
    ),
  })
  .parse(kubectl(["get", "crds"]));
for (const { spec } of definitions.items) {
  if (spec.group === API_GROUP || !["PaseoProject", "PaseoWorkspace"].includes(spec.names.kind))
    continue;
  const records = z
    .object({ items: z.array(z.unknown()) })
    .parse(kubectl(["get", `${spec.names.plural}.${spec.group}`, "--namespace", namespace]));
  if (records.items.length) {
    console.error(
      `Cannot upgrade in place: ${namespace} contains ${spec.names.kind} records under ${spec.group}. ` +
        `The current API group is ${API_GROUP}. See docs/operations.md#api-group-transition before replacing the gateway. ` +
        "No cluster resources were changed.",
    );
    process.exit(1);
  }
}
