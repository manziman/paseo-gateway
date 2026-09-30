import assert from "node:assert/strict";
import test from "node:test";
import { assess, parseArgs } from "../scripts/eks-preflight.mjs";

test("preflight cannot silently use a current context or default namespace", () => {
  assert.throws(() => parseArgs([]), /explicit context/);
  assert.throws(() => parseArgs(["--context", "a", "--namespace", "b"]), /explicit context/);
  assert.deepEqual(
    parseArgs([
      "--context",
      "a",
      "--namespace",
      "b",
      "--storage-class",
      "c",
      "--network-mode",
      "auto",
      "--values",
      "d",
    ]),
    {
      context: "a",
      namespace: "b",
      "storage-class": "c",
      "network-mode": "auto",
      values: "d",
    },
  );
  assert.throws(
    () =>
      parseArgs([
        "--context",
        "a",
        "--namespace",
        "b",
        "--storage-class",
        "c",
        "--network-mode",
        "guessed",
        "--values",
        "d",
      ]),
    /network mode/,
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
    networkMode: "auto",
    values: {},
  });
  assert.equal(
    report.checks.find((item) => item.id === "network-policy-controller")?.status,
    "PASS",
  );
  assert.equal(report.checks.find((item) => item.id === "policy-at-startup")?.status, "BLOCKED");
});

test("networking mode is explicit and cannot be inferred from the storage provisioner", () => {
  const input = {
    storageClass: { provisioner: "ebs.csi.eks.amazonaws.com" },
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
    autoNetworkConfig: { data: { "enable-network-policy-controller": "true" } },
  };
  const status = (report, id) => report.checks.find((check) => check.id === id)?.status;
  assert.equal(status(assess(input), "network-policy-controller"), "BLOCKED");
  assert.equal(status(assess({ ...input, networkMode: "standard" }), "policy-at-startup"), "PASS");
  assert.equal(status(assess({ ...input, networkMode: "auto" }), "policy-at-startup"), "BLOCKED");
});

test("preflight binds the inspected class to chart values and rejects broad egress", () => {
  const values = {
    workspace: { storageClass: "encrypted-ebs" },
    networkPolicy: {
      egress: {
        enabled: true,
        rules: [
          {
            to: [{ namespaceSelector: { matchLabels: { approved: "true" } } }],
            ports: [{ protocol: "TCP", port: 8443 }],
          },
        ],
      },
    },
  };
  const input = {
    storageClass: { metadata: { name: "encrypted-ebs" } },
    values,
  };
  const status = (report, id) => report.checks.find((check) => check.id === id)?.status;
  assert.equal(status(assess(input), "storage-class-selection"), "PASS");
  assert.equal(status(assess(input), "configured-egress"), "PASS");
  assert.equal(
    status(
      assess({ ...input, values: { ...values, workspace: { storageClass: "other" } } }),
      "storage-class-selection",
    ),
    "BLOCKED",
  );
  for (const rule of [
    {},
    { to: [{}], ports: [{ protocol: "TCP", port: 8443 }] },
    { to: [{ namespaceSelector: { matchLabels: {} } }], ports: [{ protocol: "TCP", port: 8443 }] },
    { to: [{ ipBlock: { cidr: "0.0.0.0/0" } }], ports: [{ protocol: "TCP", port: 8443 }] },
    { to: [{ ipBlock: { cidr: "invalid" } }], ports: [{ protocol: "TCP", port: 8443 }] },
    { to: [{ ipBlock: { cidr: "10.0.0.0/24" } }] },
  ]) {
    const report = assess({
      ...input,
      values: { ...values, networkPolicy: { egress: { enabled: true, rules: [rule] } } },
    });
    assert.equal(status(report, "configured-egress"), "BLOCKED");
  }
});

test("namespace and CRD checks require active, established UID-scoped resources", () => {
  const names = ["paseoprojects", "paseoworkspaces", "paseocredentialprofiles"];
  const crds = names.map((name) => ({
    metadata: { name: `${name}.paseo-gateway.manziman.github.io` },
    spec: {
      group: "paseo-gateway.manziman.github.io",
      scope: "Namespaced",
      versions: [{ name: "v1alpha1", served: true, storage: true }],
    },
    status: { conditions: [{ type: "Established", status: "True" }] },
  }));
  const input = {
    namespace: { metadata: { name: "fixture", uid: "fixed-uid" }, status: { phase: "Active" } },
    crds,
  };
  const status = (report, id) => report.checks.find((check) => check.id === id)?.status;
  assert.equal(status(assess(input), "namespace"), "PASS");
  assert.equal(status(assess(input), "required-crds"), "PASS");
  assert.equal(
    status(
      assess({ ...input, namespace: { ...input.namespace, status: { phase: "Terminating" } } }),
      "namespace",
    ),
    "BLOCKED",
  );
  assert.equal(
    status(assess({ ...input, crds: [crds[0], crds[1], crds[1]] }), "required-crds"),
    "BLOCKED",
  );
  assert.equal(
    status(
      assess({ ...input, crds: crds.map((crd) => ({ ...crd, status: {} })) }),
      "required-crds",
    ),
    "BLOCKED",
  );
});

test("TLS identities must be separate and external gateway host must be explicit", () => {
  const values = {
    transport: {
      tls: { enabled: true, gatewaySecret: "gateway-tls", workspaceSecret: "workspace-tls" },
    },
    gateway: { allowedHosts: "localhost,approved.example" },
  };
  const status = (report, id) => report.checks.find((check) => check.id === id)?.status;
  assert.equal(status(assess({ values }), "chart-transport-tls"), "PASS");
  assert.equal(status(assess({ values }), "gateway-host-allowlist"), "PASS");
  assert.equal(
    status(
      assess({
        values: {
          ...values,
          transport: { tls: { enabled: true, gatewaySecret: "same", workspaceSecret: "same" } },
        },
      }),
      "chart-transport-tls",
    ),
    "BLOCKED",
  );
  assert.equal(
    status(
      assess({ values: { ...values, gateway: { allowedHosts: "localhost,127.0.0.1" } } }),
      "gateway-host-allowlist",
    ),
    "BLOCKED",
  );
});
