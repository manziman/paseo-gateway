#!/usr/bin/env node
// Read-only EKS qualification. Deliberately emits no context, namespace, endpoint,
// account, image, credential, or error text from kubectl.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import YAML from "yaml";

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (
      !["--context", "--namespace", "--storage-class", "--values"].includes(flag) ||
      !argv[i + 1]
    ) {
      throw new Error(
        "usage: node scripts/eks-preflight.mjs --context CONTEXT --namespace NAMESPACE --storage-class CLASS --values LOCAL_VALUES_FILE",
      );
    }
    options[flag.slice(2)] = argv[i + 1];
  }
  if (!["context", "namespace", "storage-class", "values"].every((key) => options[key])) {
    throw new Error(
      "explicit context, namespace, storage class, and local values file are required",
    );
  }
  return options;
}

export function assess({
  namespace,
  version,
  storageClass,
  csiDrivers,
  cni,
  autoNetworkConfig,
  crds,
  permissions,
  values,
}) {
  const checks = [];
  const add = (id, status, reason) => checks.push({ id, status, reason });
  add(
    "namespace",
    namespace?.metadata?.name ? "PASS" : "BLOCKED",
    namespace?.metadata?.name ? "Selected namespace exists" : "Namespace unavailable or unreadable",
  );
  const k8s = version?.serverVersion?.gitVersion;
  const supported = /^v?1\.(32|33|34|35)\./.test(k8s ?? "");
  add(
    "kubernetes-version",
    supported ? "PASS" : "BLOCKED",
    supported
      ? `API reports ${k8s}; within chart's declared 1.32–1.35 range`
      : "Version unavailable or outside chart's declared 1.32–1.35 range",
  );
  const provisioner = storageClass?.provisioner;
  const recognized = ["ebs.csi.aws.com", "ebs.csi.eks.amazonaws.com"].includes(provisioner);
  add(
    "ebs-csi",
    recognized && csiDrivers?.items?.some((driver) => driver.metadata?.name === provisioner)
      ? "PASS"
      : "BLOCKED",
    recognized
      ? "EBS CSI provisioner and driver must both be observed"
      : "Selected class is not a recognized EBS CSI provisioner",
  );
  add(
    "ebs-csi-version",
    "BLOCKED",
    "CSI driver version and node compatibility require separate operator evidence",
  );
  add(
    "encrypted-storage",
    storageClass?.parameters?.encrypted === "true" ? "PASS" : "BLOCKED",
    storageClass?.parameters?.encrypted === "true"
      ? "StorageClass explicitly requests encrypted volumes; verify actual provisioned volume later"
      : "StorageClass lacks explicit encrypted=true; account defaults cannot be inferred",
  );
  const containers = cni?.spec?.template?.spec?.containers ?? [];
  const agent = containers.find((item) => item.name === "aws-network-policy-agent");
  const enabled = agent?.args?.some((arg) => arg === "--enable-network-policy=true");
  const awsNode = containers.find((item) => item.name === "aws-node");
  const strict = awsNode?.env?.some(
    (item) => item.name === "NETWORK_POLICY_ENFORCING_MODE" && item.value === "strict",
  );
  const autoMode = provisioner === "ebs.csi.eks.amazonaws.com";
  const autoEnabled = autoNetworkConfig?.data?.["enable-network-policy-controller"] === "true";
  add(
    "network-policy-controller",
    autoMode ? (autoEnabled ? "PASS" : "BLOCKED") : enabled ? "PASS" : "BLOCKED",
    autoMode
      ? autoEnabled
        ? "Auto Mode network policy controller flag observed; enforcement still requires live probes"
        : "Auto Mode network policy controller flag not confirmed"
      : enabled
        ? "VPC CNI policy agent appears enabled; enforcement requires live probes"
        : "VPC CNI policy agent not confirmed enabled",
  );
  add(
    "policy-at-startup",
    autoMode ? "BLOCKED" : strict ? "PASS" : "BLOCKED",
    autoMode
      ? "Selected Auto Mode NodeClass startup policy requires private review and live startup probe"
      : strict
        ? "VPC CNI strict startup mode observed"
        : "Strict startup mode not observed; a new pod may start with default allow",
  );
  add(
    "namespace-rbac",
    permissions?.length && permissions.every((permission) => permission.allowed)
      ? "PASS"
      : "BLOCKED",
    permissions?.length && permissions.every((permission) => permission.allowed)
      ? "Operator fixture verbs authorized; installed gateway ServiceAccount requires separate validation"
      : "One or more operator fixture verbs denied or unverified",
  );
  add(
    "required-crds",
    crds?.length === 3 && crds.every(Boolean) ? "PASS" : "BLOCKED",
    crds?.length === 3 && crds.every(Boolean)
      ? "Three required CRDs are observable; schema compatibility still needs review"
      : "One or more chart CRDs are absent or unreadable; cluster-scoped installation needs separate operator handling",
  );
  add(
    "gateway-serviceaccount-rbac",
    "BLOCKED",
    "Gateway ServiceAccount permissions require a live namespaced install and authorization probes",
  );
  const ingress = values?.networkPolicy?.enabled === true;
  const egress = values?.networkPolicy?.egress?.enabled === true;
  add(
    "chart-network-policy",
    ingress && egress ? "PASS" : "BLOCKED",
    ingress && egress
      ? "Ingress and egress policies requested; live enforcement unverified"
      : "Values must enable ingress and egress policies",
  );
  const egressRules = values?.networkPolicy?.egress?.rules;
  const profileRules = values?.networkPolicy?.egress?.profiles;
  add(
    "configured-egress",
    egress && (egressRules?.length || profileRules?.some((profile) => profile.rules?.length))
      ? "PASS"
      : "BLOCKED",
    egress && (egressRules?.length || profileRules?.some((profile) => profile.rules?.length))
      ? "At least one outbound rule requested; approved destination and effective enforcement require live review"
      : "No configured outbound destination beyond chart DNS/gateway allowance",
  );
  const digestPattern = /^sha256:[a-f0-9]{64}$/;
  const pinnedImages =
    digestPattern.test(values?.image?.digest ?? "") &&
    digestPattern.test(values?.workspace?.digest ?? "");
  add(
    "candidate-digests",
    pinnedImages ? "PASS" : "BLOCKED",
    pinnedImages
      ? "Gateway and workspace candidate digests are pinned in local values"
      : "Exact gateway and workspace candidate digests missing from local values",
  );
  const tlsRequested =
    values?.transport?.tls?.enabled === true &&
    typeof values?.transport?.tls?.gatewaySecret === "string" &&
    values.transport.tls.gatewaySecret.length > 0 &&
    typeof values?.transport?.tls?.workspaceSecret === "string" &&
    values.transport.tls.workspaceSecret.length > 0;
  add(
    "chart-transport-tls",
    tlsRequested ? "PASS" : "BLOCKED",
    tlsRequested
      ? "Chart TLS and two Secret names configured; Secret keys, trust and handshake require live validation"
      : "TLS and separate gateway/workspace Secret names required in local values",
  );
  add(
    "backend-transport",
    "BLOCKED",
    "Gateway-to-workspace TLS handshake, certificate identity and trust require live validation",
  );
  add(
    "gateway-transport",
    "BLOCKED",
    "External gateway TLS termination and end-to-end certificate validation require operator evidence",
  );
  add(
    "single-pod-volume-mode",
    values?.workspace?.storageAccessMode === "ReadWriteOncePod" ? "PASS" : "BLOCKED",
    values?.workspace?.storageAccessMode === "ReadWriteOncePod"
      ? "ReadWriteOncePod requested; CSI behavior and partition fencing require live validation"
      : "ReadWriteOncePod must be requested for isolated qualification PVCs",
  );
  add(
    "image-pull",
    "BLOCKED",
    "Image pull for exact candidate digests requires an isolated live fixture",
  );
  add(
    "network-isolation",
    "BLOCKED",
    "Positive and negative in-cluster traffic probes have not run",
  );
  add(
    "writer-fencing",
    "BLOCKED",
    "Access mode and one replica do not prove fencing after node partition; dedicated failure fixture required",
  );
  return { schemaVersion: 1, mode: "read-only", qualification: "BLOCKED", checks };
}

function kubectl(context, namespace, args) {
  const result = spawnSync(
    "kubectl",
    ["--context", context, "--namespace", namespace, "--request-timeout=15s", ...args],
    { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function json(context, namespace, args) {
  const output = kubectl(context, namespace, args);
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  let values;
  try {
    values = YAML.parse(readFileSync(options.values, "utf8"));
  } catch {
    process.stderr.write("Local values file missing or invalid\n");
    process.exitCode = 2;
    return;
  }
  const base = ["get"];
  const namespace = json(options.context, options.namespace, [
    ...base,
    "namespace",
    options.namespace,
    "-o",
    "json",
  ]);
  const version = json(options.context, options.namespace, ["version", "-o", "json"]);
  const storageClass = json(options.context, options.namespace, [
    ...base,
    "storageclass",
    options["storage-class"],
    "-o",
    "json",
  ]);
  const csiDrivers = json(options.context, options.namespace, [
    ...base,
    "csidrivers",
    "-o",
    "json",
  ]);
  const cni = json(options.context, options.namespace, [
    ...base,
    "daemonset",
    "aws-node",
    "-n",
    "kube-system",
    "-o",
    "json",
  ]);
  const autoNetworkConfig = json(options.context, options.namespace, [
    ...base,
    "configmap",
    "amazon-vpc-cni",
    "-n",
    "kube-system",
    "-o",
    "json",
  ]);
  const crds = ["paseoprojects", "paseoworkspaces", "paseocredentialprofiles"].map((kind) =>
    json(options.context, options.namespace, [
      ...base,
      "customresourcedefinition",
      `${kind}.paseo-gateway.manziman.github.io`,
      "-o",
      "json",
    ]),
  );
  const required = [
    ["create", "deployments.apps"],
    ["get", "deployments.apps"],
    ["patch", "deployments.apps"],
    ["delete", "deployments.apps"],
    ["create", "persistentvolumeclaims"],
    ["get", "persistentvolumeclaims"],
    ["delete", "persistentvolumeclaims"],
    ["create", "networkpolicies.networking.k8s.io"],
    ["get", "pods"],
    ["create", "pods/exec"],
    ["create", "secrets"],
    ["get", "secrets"],
    ["create", "services"],
    ["get", "events"],
  ];
  const permissions = required.map(([verb, resource]) => ({
    allowed:
      kubectl(options.context, options.namespace, ["auth", "can-i", verb, resource]) === "yes",
  }));
  const report = assess({
    namespace,
    version,
    storageClass,
    csiDrivers,
    cni,
    autoNetworkConfig,
    crds,
    permissions,
    values,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.checks.some((check) => check.status === "BLOCKED") ? 1 : 0;
}

if (process.argv[1]?.endsWith("eks-preflight.mjs")) main();
