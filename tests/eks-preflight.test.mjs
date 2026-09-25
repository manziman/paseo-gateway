import assert from "node:assert/strict";
import test from "node:test";
import { assess, parseArgs } from "../scripts/eks-preflight.mjs";

test("preflight cannot silently use a current context or default namespace", () => {
  assert.throws(() => parseArgs([]), /explicit context/);
  assert.throws(() => parseArgs(["--context", "a", "--namespace", "b"]), /explicit context/);
  assert.deepEqual(
    parseArgs(["--context", "a", "--namespace", "b", "--storage-class", "c", "--values", "d"]),
    {
      context: "a",
      namespace: "b",
      "storage-class": "c",
      values: "d",
    },
  );
});

test("read-only observations do not turn live requirements into passes or expose identities", () => {
  const report = assess({
    namespace: { metadata: { name: "private-namespace" } },
    version: { serverVersion: { gitVersion: "v1.31.0" } },
    storageClass: {
      provisioner: "ebs.csi.aws.com",
      parameters: { encrypted: "true", kmsKeyId: "private-key-arn" },
    },
    csiDrivers: { items: [{ metadata: { name: "ebs.csi.aws.com" } }] },
    cni: {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "aws-node",
                env: [{ name: "NETWORK_POLICY_ENFORCING_MODE", value: "strict" }],
              },
              { name: "aws-network-policy-agent", args: ["--enable-network-policy=true"] },
            ],
          },
        },
      },
    },
    permissions: [{ allowed: true }],
    values: {
      image: { digest: `sha256:${"a".repeat(64)}` },
      workspace: { digest: `sha256:${"b".repeat(64)}`, storageAccessMode: "ReadWriteOncePod" },
      networkPolicy: { enabled: true, egress: { enabled: true, rules: [{}] } },
      transport: {
        tls: { enabled: true, gatewaySecret: "gateway-tls", workspaceSecret: "workspace-tls" },
      },
    },
  });
  assert.equal(report.qualification, "BLOCKED");
  assert.equal(report.checks.find((item) => item.id === "encrypted-storage")?.status, "PASS");
  assert.equal(report.checks.find((item) => item.id === "chart-transport-tls")?.status, "PASS");
  assert.equal(report.checks.find((item) => item.id === "single-pod-volume-mode")?.status, "PASS");
  assert.equal(report.checks.find((item) => item.id === "backend-transport")?.status, "BLOCKED");
  assert.equal(report.checks.find((item) => item.id === "writer-fencing")?.status, "BLOCKED");
  assert.doesNotMatch(JSON.stringify(report), /private-namespace|private-key-arn/);
});

test("unreadable resources and missing credentials remain blocked", () => {
  const report = assess({ values: {} });
  for (const check of report.checks) assert.equal(check.status, "BLOCKED");
});

test("Auto Mode uses its controller flag and does not require an aws-node DaemonSet", () => {
  const report = assess({
    storageClass: { provisioner: "ebs.csi.eks.amazonaws.com", parameters: { encrypted: "true" } },
    csiDrivers: { items: [{ metadata: { name: "ebs.csi.eks.amazonaws.com" } }] },
    autoNetworkConfig: { data: { "enable-network-policy-controller": "true" } },
    values: {},
  });
  assert.equal(
    report.checks.find((item) => item.id === "network-policy-controller")?.status,
    "PASS",
  );
  assert.equal(report.checks.find((item) => item.id === "policy-at-startup")?.status, "BLOCKED");
});
