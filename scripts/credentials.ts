import { readFile } from "node:fs/promises";
import { CoreV1Api } from "@kubernetes/client-node";
import { loadKubernetesConfig } from "../src/kubernetes/client.js";
import { statusCode } from "../src/kubernetes/store.js";

const file = process.argv[2];
if (!file)
  throw new Error(
    "Usage: npm run credentials -- /path/to/token-file. Generate the token with claude setup-token; do not paste it into chat.",
  );
const token = (await readFile(file, "utf8")).trim();
if (!token || /\s/.test(token))
  throw new Error("Expected a file containing only the subscription token");
const api = loadKubernetesConfig("docker-desktop").makeApiClient(CoreV1Api);
const namespace = "paseo-system";
const name = "claude-default";
try {
  const existing = await api.readNamespacedSecret({ namespace, name });
  await api.replaceNamespacedSecret({
    namespace,
    name,
    body: { ...existing, data: { token: Buffer.from(token).toString("base64") } },
  });
} catch (error) {
  if (statusCode(error) !== 404) throw new Error("Credential update failed (API details redacted)");
  try {
    await api.createNamespacedSecret({
      namespace,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: { name, namespace },
        stringData: { token },
      },
    });
  } catch {
    throw new Error("Credential creation failed (API details redacted)");
  }
}
console.log(
  "Claude profile stored. Existing pods retain their current environment; suspend/resume them when idle to adopt this token. No pod was restarted.",
);
