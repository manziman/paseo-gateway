#!/usr/bin/env node
// Evidence completeness gate; never prints operator evidence paths or content.
import { readFileSync } from "node:fs";

export const required = [
  "desktop.connection",
  "desktop.project",
  "desktop.workspace",
  "desktop.agent",
  "desktop.timeline",
  "desktop.permission",
  "desktop.git-file",
  "desktop.terminal",
  "desktop.schedule",
  "desktop.existing-agent-schedule",
  "sdk.directory",
  "sdk.reconnect",
  "sdk.ambiguous",
  "sdk.capabilities",
];

export function grade(evidence) {
  const checks = required.map((id) => {
    const item = evidence?.[id];
    const expectedKind = id.startsWith("desktop.") ? "live-desktop" : "live-sdk";
    const validPass =
      item?.status === "PASS" &&
      item?.kind === expectedKind &&
      typeof item?.evidence === "string" &&
      item.evidence.trim().length > 0;
    return { id, status: validPass ? "PASS" : item?.status === "FAIL" ? "FAIL" : "BLOCKED" };
  });
  return {
    schemaVersion: 1,
    qualification: checks.every((item) => item.status === "PASS") ? "PASS" : "BLOCKED",
    checks,
  };
}

if (process.argv[1]?.endsWith("client-acceptance.mjs")) {
  if (process.argv.length !== 4 || process.argv[2] !== "--evidence") {
    process.stderr.write("usage: node scripts/client-acceptance.mjs --evidence LOCAL_JSON_FILE\n");
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
