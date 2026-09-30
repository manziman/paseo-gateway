import { describe, expect, it } from "vitest";
import { desiredResources } from "../src/controller/resources.js";
import { API_VERSION, CredentialProfileSchema } from "../src/domain.js";
import { project, workspace } from "./fixtures.js";

const runtime = {
  workspaceImage: "workspace:test",
  storageSize: "5Gi",
  backendSecret: "backend",
  imagePullPolicy: "Never" as const,
};

describe("projected profile file initialization", () => {
  it("creates home and nested parents as the workspace UID before checkout subPath mounts", () => {
    const profile = CredentialProfileSchema.parse({
      apiVersion: API_VERSION,
      kind: "PaseoCredentialProfile",
      metadata: { name: "claude-default", namespace: "test" },
      spec: {
        files: [
          {
            path: ".config/opencode/opencode.json",
            valueFrom: { secretKeyRef: { name: "provider", key: "config" } },
          },
          {
            path: ".config/another/settings.json",
            valueFrom: { configMapKeyRef: { name: "settings", key: "config" } },
          },
        ],
      },
    });
    const pod = desiredResources(workspace(), project(), runtime, profile).pod;
    const [prepare, checkout] = pod.spec?.initContainers ?? [];
    expect(prepare?.name).toBe("prepare-home");
    expect(checkout?.name).toBe("checkout");
    expect(pod.spec?.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
    });
    expect(prepare?.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
    });
    expect(prepare?.volumeMounts).toEqual([
      { name: "data", mountPath: "/data" },
      { name: "tmp", mountPath: "/tmp" },
    ]);
    expect(prepare?.env).toBeUndefined();
    expect(prepare?.command).toEqual([
      "node",
      "-e",
      expect.any(String),
      "/data/home",
      "/data/home/.config/opencode",
      "/data/home/.config/another",
    ]);
    expect(checkout?.volumeMounts).toContainEqual({
      name: "profile-file-0",
      mountPath: "/data/home/.config/opencode/opencode.json",
      readOnly: true,
      subPath: "value",
    });
  });

  it("keeps the existing single checkout init when no profile files are projected", () => {
    const pod = desiredResources(workspace(), project(), runtime).pod;
    expect(pod.spec?.initContainers?.map((container) => container.name)).toEqual(["checkout"]);
  });
});
