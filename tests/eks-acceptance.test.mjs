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

test("all operational install and startup gates require their own live evidence", () => {
  const omitted = new Set([
    "install.crd-and-serviceaccount-rbac",
    "install.rwop-claim",
    "transport.certificate-identity",
    "network.startup-enforcement",
  ]);
  const evidence = Object.fromEntries(
    required
      .filter((id) => !omitted.has(id))
      .map((id) => [
        id,
        {
          status: "PASS",
          kind: "live-eks",
          evidence: "private receipt",
          ...(id === "failure.old-writer-fenced" ? { dedicatedFailureFixture: true } : {}),
        },
      ]),
  );
  const report = grade(evidence);
  assert.equal(report.qualification, "BLOCKED");
  for (const id of omitted)
    assert.equal(report.checks.find((check) => check.id === id)?.status, "BLOCKED");
});
