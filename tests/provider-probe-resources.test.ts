import { describe, expect, it } from "vitest";
import { API_VERSION, type CredentialProfile } from "../src/domain.js";
import {
  isOwnedProviderProbe,
  providerProbeResources,
} from "../src/gateway/provider-probe-resources.js";
import { project } from "./fixtures.js";

function input() {
  const row = project();
  row.metadata.uid = "project-uid";
  const profile: CredentialProfile = {
    apiVersion: API_VERSION,
    kind: "PaseoCredentialProfile" as const,
    metadata: { name: "claude-default", namespace: "test" },
    spec: {
      env: [
        {
          name: "ANTHROPIC_API_KEY",
          valueFrom: { secretKeyRef: { name: "provider-access", key: "token" } },
        },
      ],
      files: [],
      git: {
        tokenSecretRef: { name: "git-access", key: "token" },
        signing: { keySecretRef: { name: "signing-key", key: "key" }, format: "ssh" as const },
        username: "x-access-token",
      },
      runtime: { image: "profile:v1" },
    },
  };
  return { row, profile };
}

describe("provider probe resources", () => {
  it("uses a Project owner, ephemeral checkout, exact image and provider profile without a Kubernetes token", () => {
    const { row, profile } = input();
    const result = providerProbeResources({
      project: row,
      profile,
      runId: "11111111-2222-4333-8444-555555555555",
      config: {
        workspaceImage: "default:v1",
        storageSize: "5Gi",
        backendSecret: "backend",
        imagePullPolicy: "IfNotPresent",
        tlsSecret: "workspace-tls",
        gatewayUrl: "https://gateway.invalid",
      },
    });
    expect(result.pod.metadata?.ownerReferences).toMatchObject([
      { kind: "PaseoProject", uid: "project-uid" },
    ]);
    expect(result.service.metadata?.ownerReferences).toMatchObject([
      { kind: "PaseoProject", uid: "project-uid" },
    ]);
    expect(result.pod.spec?.automountServiceAccountToken).toBe(false);
    expect(result.pod.spec?.activeDeadlineSeconds).toBe(300);
    expect(result.pod.spec?.volumes?.find((volume) => volume.name === "data")).toMatchObject({
      emptyDir: { sizeLimit: "1Gi" },
    });
    expect(result.pod.spec?.volumes?.some((volume) => volume.persistentVolumeClaim)).toBe(false);
    expect(result.pod.spec?.volumes?.some((volume) => volume.name === "gateway-access")).toBe(
      false,
    );
    expect(result.pod.spec?.volumes?.some((volume) => volume.name === "git-signing")).toBe(false);
    const checkout = result.pod.spec?.initContainers?.find(
      (container) => container.name === "checkout",
    );
    const daemon = result.pod.spec?.containers.find((container) => container.name === "daemon");
    expect(checkout?.image).toBe("profile:v1");
    expect(daemon?.image).toBe("profile:v1");
    expect(checkout?.volumeMounts?.some((mount) => mount.name === "git-token")).toBe(true);
    expect(daemon?.volumeMounts?.some((mount) => mount.name === "git-token")).toBe(false);
    expect(daemon?.env?.some((env) => env.name === "ANTHROPIC_API_KEY")).toBe(true);
    expect(daemon?.env?.some((env) => env.name === "PASEO_GATEWAY_TOKEN_FILE")).toBe(false);
    if (!result.pod.metadata) throw new Error("Test Pod metadata is unavailable");
    result.pod.metadata.uid = "probe-pod-uid";
    expect(
      isOwnedProviderProbe({ object: result.pod, name: result.name, projectUid: "project-uid" }),
    ).toBe(true);
    expect(
      isOwnedProviderProbe({ object: result.pod, name: result.name, projectUid: "other" }),
    ).toBe(false);
  });
});
