import { describe, expect, it } from "vitest";
import { API_VERSION, type CredentialProfile } from "../src/domain.js";
import { effectiveWorkspaceImage, projectForCatalogPath } from "../src/gateway/provider-catalog.js";
import { project } from "./fixtures.js";

describe("project provider catalog scope", () => {
  it("accepts only an exact configured project path", () => {
    expect(projectForCatalogPath("/projects/example", [project()])?.metadata.name).toBe("example");
    for (const path of ["/projects/other", "/projects/example/subdir", "/workspaces/one"])
      expect(projectForCatalogPath(path, [project()])).toBeUndefined();
  });

  it("uses the same image precedence as workspace resources", () => {
    const row = project();
    const profile: CredentialProfile = {
      apiVersion: API_VERSION,
      kind: "PaseoCredentialProfile",
      metadata: { name: "claude-default", namespace: "test" },
      spec: { env: [], files: [] },
    };
    expect(effectiveWorkspaceImage({ project: row, profile, defaultImage: "default:v1" })).toBe(
      "default:v1",
    );
    profile.spec.runtime = { image: "profile:v1" };
    expect(effectiveWorkspaceImage({ project: row, profile, defaultImage: "default:v1" })).toBe(
      "profile:v1",
    );
    row.spec.runtime = { image: "project:v1" };
    expect(effectiveWorkspaceImage({ project: row, profile, defaultImage: "default:v1" })).toBe(
      "project:v1",
    );
  });
});
