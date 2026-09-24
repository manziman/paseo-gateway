import { describe, expect, it } from "vitest";
import { redactUpstreamDiagnostics } from "../scripts/upstream-diagnostics.js";

describe("upstream startup diagnostics", () => {
  it("retains actionable failure state while suppressing generated credentials and pairing output", () => {
    const result = redactUpstreamDiagnostics(
      "exited code 1\nconnection refused\npassword=my-test-password\npairing URL: private\nraw my-test-password",
      "my-test-password",
    );
    expect(result).toContain("exited code 1");
    expect(result).toContain("connection refused");
    expect(result).not.toContain("my-test-password");
    expect(result).not.toContain("private");
  });
  it("bounds diagnostics even for excessive container logs", () => {
    expect(redactUpstreamDiagnostics("x".repeat(100_000), "secret-value")).toHaveLength(8000);
  });
});
