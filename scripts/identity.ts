import { randomBytes, randomUUID } from "node:crypto";
import { CoreV1Api } from "@kubernetes/client-node";
import { loadKubernetesConfig } from "../src/kubernetes/client.js";
import { statusCode } from "../src/kubernetes/store.js";
import { context, namespace } from "./local-config.js";

const api = loadKubernetesConfig(context).makeApiClient(CoreV1Api);
for (const name of ["paseo-identity", "paseo-backend"]) {
  try {
    await api.readNamespacedSecret({ namespace, name });
  } catch (error) {
    if (statusCode(error) !== 404) throw new Error("Cannot read identity Secret");
    try {
      await api.createNamespacedSecret({
        namespace,
        body: {
          apiVersion: "v1",
          kind: "Secret",
          type: "Opaque",
          metadata: { name, namespace },
          immutable: true,
          stringData: {
            password: randomBytes(32).toString("hex"),
            ...(name === "paseo-identity" ? { serverId: randomUUID() } : {}),
          },
        },
      });
    } catch (error) {
      if (statusCode(error) !== 409) throw new Error("Cannot create identity Secret");
    }
  }
  console.log(`${name}: retained identity is present (values redacted)`);
}
