import { describe, expect, it } from "vitest";
import { classifyRejectedTurn } from "../scripts/provider-failure-contract.js";

const marker = "RESTORED_TEST_MARKER";
function evidence(assistantTexts: string[], status = "idle") {
  return {
    status,
    structuredErrors: [],
    lastMessage: assistantTexts.at(-1) ?? null,
    assistantTexts,
    successMarker: marker,
  };
}

describe("provider rejection evidence", () => {
  it.each(["Not logged in · Please run /login", "Invalid API key", "Unauthorized 401"])(
    "accepts a bounded native auth failure message: %s",
    (message) => {
      expect(classifyRejectedTurn(evidence([message]))).toBe("native-idle-assistant-auth-error");
    },
  );

  it("accepts a structured authentication error without a success reply", () => {
    expect(
      classifyRejectedTurn({
        ...evidence([]),
        status: "error",
        structuredErrors: ["Authentication failed"],
      }),
    ).toBe("structured-authentication-error");
  });

  it("rejects an idle turn with no assistant reply, even if the user prompt mentions login", () => {
    expect(classifyRejectedTurn(evidence([]))).toBeNull();
  });

  it("rejects generic failure text without an authentication category", () => {
    expect(classifyRejectedTurn(evidence(["Request failed; retry later"]))).toBeNull();
  });

  it("rejects mixed auth and successful assistant messages", () => {
    expect(
      classifyRejectedTurn(evidence(["Not logged in · Please run /login", `Done ${marker}`])),
    ).toBeNull();
  });

  it("rejects a success marker even when the same assistant message mentions an auth error", () => {
    expect(
      classifyRejectedTurn(evidence([`Not logged in · Please run /login; ${marker}`])),
    ).toBeNull();
  });

  it("rejects an idle turn that has only a structured error and no native assistant error", () => {
    expect(
      classifyRejectedTurn({
        ...evidence([]),
        structuredErrors: ["Unauthorized 401"],
      }),
    ).toBeNull();
  });
});
