import { describe, expect, it } from "vitest";
import { ProviderAcceptanceConfigSchema } from "../scripts/provider-acceptance-config.js";

describe("explicit provider acceptance configuration", () => {
  const base = {
    context: "docker-desktop",
    namespace: "provider-acceptance",
    cases: [{ provider: "codex", authentication: "codex-subscription-authority" }],
  };
  it("requires an explicit context and leaves missing provider projects as blocked prerequisites", () => {
    expect(() => ProviderAcceptanceConfigSchema.parse({ ...base, context: undefined })).toThrow();
    const parsed = ProviderAcceptanceConfigSchema.parse(base);
    expect(parsed.cases[0]?.project).toBeUndefined();
    expect(parsed.replaceGateway).toBe(false);
    expect(parsed.activeTurnGatewayRecovery).toBe(false);
    expect(parsed.renewCodexAuthority).toBe(false);
  });
  it("rejects inline credentials and authentication substitution", () => {
    expect(() =>
      ProviderAcceptanceConfigSchema.parse({ ...base, token: "must-never-appear" }),
    ).toThrow();
    expect(() =>
      ProviderAcceptanceConfigSchema.parse({
        ...base,
        cases: [{ provider: "claude", authentication: "codex-api-key", project: "test" }],
      }),
    ).toThrow();
  });
  it("requires both CA selection and server name without an insecure verification escape hatch", () => {
    expect(() =>
      ProviderAcceptanceConfigSchema.parse({
        ...base,
        tls: { caFile: "/secure/ca", rejectUnauthorized: false },
      }),
    ).toThrow();
    expect(
      ProviderAcceptanceConfigSchema.parse({
        ...base,
        tls: { caFile: "/secure/ca", serverName: "localhost" },
      }).tls?.serverName,
    ).toBe("localhost");
  });
});
