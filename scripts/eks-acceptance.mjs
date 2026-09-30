#!/usr/bin/env node
// Grades local evidence without copying private observations into public output.
import { readFileSync } from "node:fs";

export const required = [
  "install.crd-and-serviceaccount-rbac",
  "install.digest-and-pull",
  "install.pvc-encryption",
  "install.rwop-claim",
  "transport.gateway-tls",
  "transport.backend-tls",
  "transport.certificate-identity",
  "workflow.private-orchestrator-worker",
  "workflow.provider-catalog",
  "network.allowed",
  "network.cross-workspace-denied",
  "network.disallowed-egress-denied",
  "network.metadata-denied",
  "network.startup-enforcement",
  "recovery.workspace-pvc-identity-history",
  "recovery.gateway-generation",
  "recovery.suspend-resume",
  "recovery.upgrade-rollback-reinstall",
  "recovery.ambiguous-no-replay",
  "failure.api-unavailable",
  "failure.unschedulable-capacity",
  "failure.oom-eviction",
  "failure.teardown-retains-data",
  "failure.old-writer-fenced",
  "cleanup.uid-ownership-verified",
  "cleanup.requested-data-retained",
];

export function grade(evidence) {
  const checks = required.map((id) => {
    const entry = evidence?.[id];
    const dedicated = id !== "failure.old-writer-fenced" || entry?.dedicatedFailureFixture === true;
    const pass =
      entry?.status === "PASS" &&
      entry?.kind === "live-eks" &&
      typeof entry?.evidence === "string" &&
      entry.evidence.trim() !== "" &&
      dedicated;
    return { id, status: pass ? "PASS" : entry?.status === "FAIL" ? "FAIL" : "BLOCKED" };
  });
  return {
    schemaVersion: 1,
    qualification: checks.every((entry) => entry.status === "PASS") ? "PASS" : "BLOCKED",
    checks,
  };
}

if (process.argv[1]?.endsWith("eks-acceptance.mjs")) {
  if (process.argv.length !== 4 || process.argv[2] !== "--evidence") {
    process.stderr.write("usage: node scripts/eks-acceptance.mjs --evidence LOCAL_JSON_FILE\n");
    process.exitCode = 2;
  } else {
    try {
      const report = grade(JSON.parse(readFileSync(process.argv[3], "utf8")));
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.qualification === "PASS" ? 0 : 1;
    } catch {
      process.stderr.write("Evidence file missing or invalid\n");
      process.exitCode = 2;
    }
  }
}
