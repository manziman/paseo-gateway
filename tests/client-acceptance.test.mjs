import assert from "node:assert/strict";
import test from "node:test";
import { grade, required } from "../scripts/client-acceptance.mjs";

test("fixture and omitted evidence cannot satisfy live desktop or SDK acceptance", () => {
  const report = grade({
    "desktop.connection": { status: "PASS", kind: "fixture", evidence: "private-endpoint" },
    "sdk.directory": { status: "PASS", kind: "live-sdk", evidence: "" },
  });
  assert.equal(report.qualification, "BLOCKED");
  assert.equal(report.checks.length, required.length);
  assert(report.checks.every((item) => item.status === "BLOCKED"));
  assert.doesNotMatch(JSON.stringify(report), /private-endpoint/);
});

test("all required live observations are necessary", () => {
  const evidence = Object.fromEntries(
    required.map((id) => [
      id,
      {
        status: "PASS",
        kind: id.startsWith("desktop.") ? "live-desktop" : "live-sdk",
        evidence: "local-reference",
      },
    ]),
  );
  assert.equal(grade(evidence).qualification, "PASS");
  delete evidence["sdk.ambiguous"];
  assert.equal(grade(evidence).qualification, "BLOCKED");
});
