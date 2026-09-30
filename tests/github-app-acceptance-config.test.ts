import { describe, expect, it } from "vitest";
import { GitHubAppAcceptanceConfigSchema } from "../scripts/github-app-acceptance-config.js";

describe("explicit disposable GitHub App acceptance selection", () => {
  const base = {
    context: "docker-desktop",
    namespace: "acceptance",
    workspace: "selected-workspace",
    forceRenewal: true,
  };
  it("defaults repository writes and token revocation off", () => {
    const config = GitHubAppAcceptanceConfigSchema.parse(base);
    expect(config.privateWrite).toBeUndefined();
    expect(config.revokeNewlyMintedToken).toBe(false);
    expect(config.suspendAfter).toBe(false);
  });
  it("requires explicit context and rejects inline credentials or arbitrary repository URLs", () => {
    expect(() => GitHubAppAcceptanceConfigSchema.parse({ ...base, context: undefined })).toThrow();
    expect(() => GitHubAppAcceptanceConfigSchema.parse({ ...base, token: "unaccepted" })).toThrow();
    expect(() =>
      GitHubAppAcceptanceConfigSchema.parse({
        ...base,
        privateWrite: { repository: "https://github.com/owner/repo?token=unaccepted" },
      }),
    ).toThrow();
  });
});
