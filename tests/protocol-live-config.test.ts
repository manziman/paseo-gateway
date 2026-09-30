import { describe, expect, it } from "vitest";
import { ProtocolLiveConfigSchema } from "../scripts/protocol-live-config.js";

const selected = {
  context: "docker-desktop",
  namespace: "local-test",
  project: "public-fixture",
  tls: { caFile: "/secure/local-ca.crt", serverName: "localhost" },
};

describe("protocol live selection", () => {
  it("requires an explicit local context, project, and verified TLS endpoint", () => {
    expect(ProtocolLiveConfigSchema.parse(selected).identitySecret).toBe("paseo-identity");
    expect(() => ProtocolLiveConfigSchema.parse({ ...selected, context: "production" })).toThrow();
    expect(() => ProtocolLiveConfigSchema.parse({ ...selected, project: "" })).toThrow();
    expect(() => ProtocolLiveConfigSchema.parse({ ...selected, tls: undefined })).toThrow();
  });
});
