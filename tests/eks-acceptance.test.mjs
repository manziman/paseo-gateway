import assert from "node:assert/strict";
import test from "node:test";
import { grade, required } from "../scripts/eks-acceptance.mjs";

test("read-only preflight and fixture assertions never qualify EKS", () => {
  const report = grade({
    "network.allowed": { status: "PASS", kind: "preflight", evidence: "private endpoint" },
  });
  assert.equal(report.qualification, "BLOCKED");
  assert.equal(report.checks.length, required.length);
  assert.doesNotMatch(JSON.stringify(report), /private endpoint/);
});

test("writer fencing requires explicit dedicated failure fixture evidence", () => {
  const evidence = Object.fromEntries(
    required.map((id) => [
      id,
      {
        status: "PASS",
        kind: "live-eks",
        evidence: "local evidence record",
      },
    ]),
  );
  assert.equal(grade(evidence).qualification, "BLOCKED");
  evidence["failure.old-writer-fenced"].dedicatedFailureFixture = true;
  assert.equal(grade(evidence).qualification, "PASS");
});
