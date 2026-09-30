#!/usr/bin/env node
// Read-only EKS qualification. Deliberately emits no context, namespace, endpoint,
// account, image, credential, or error text from kubectl.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import YAML from "yaml";

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (
      !["--context", "--namespace", "--storage-class", "--network-mode", "--values"].includes(
        flag,
      ) ||
      !argv[i + 1]
    ) {
      throw new Error(
        "usage: node scripts/eks-preflight.mjs --context CONTEXT --namespace NAMESPACE --storage-class CLASS --network-mode standard|auto --values LOCAL_VALUES_FILE",
      );
    }
    options[flag.slice(2)] = argv[i + 1];
  }
  if (
    !["context", "namespace", "storage-class", "network-mode", "values"].every(
      (key) => options[key],
    ) ||
    !["standard", "auto"].includes(options["network-mode"])
  ) {
    throw new Error(
      "explicit context, namespace, storage class, network mode, and local values file are required",
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
  networkMode,
  crds,
  permissions,
  values,
}) {
  const checks = [];
  const add = (id, status, reason) => checks.push({ id, status, reason });
  const namespaceReady =
    typeof namespace?.metadata?.uid === "string" &&
    namespace.metadata.uid.length > 0 &&
    namespace?.status?.phase === "Active" &&
    !namespace?.metadata?.deletionTimestamp;
  add(
    "namespace",
    namespaceReady ? "PASS" : "BLOCKED",
    namespaceReady
      ? "Selected namespace has a UID and is Active"
      : "Selected namespace must be readable, Active, and UID-recorded",
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
  add(
    "storage-class-selection",
    storageClass?.metadata?.name && values?.workspace?.storageClass === storageClass.metadata.name
      ? "PASS"
      : "BLOCKED",
    storageClass?.metadata?.name && values?.workspace?.storageClass === storageClass.metadata.name
      ? "Inspected StorageClass matches the chart's selected class"
      : "Chart StorageClass must exactly match the inspected class",
  );
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
  const autoMode = networkMode === "auto";
  const standardMode = networkMode === "standard";
  const autoEnabled = autoNetworkConfig?.data?.["enable-network-policy-controller"] === "true";
  add(
    "network-policy-controller",
    autoMode ? (autoEnabled ? "PASS" : "BLOCKED") : standardMode && enabled ? "PASS" : "BLOCKED",
    autoMode
      ? autoEnabled
        ? "Auto Mode network policy controller flag observed; enforcement still requires live probes"
        : "Auto Mode network policy controller flag not confirmed"
      : standardMode && enabled
        ? "VPC CNI policy agent appears enabled; enforcement requires live probes"
        : "Selected VPC CNI mode or policy agent not confirmed enabled",
  );
  add(
    "policy-at-startup",
    autoMode ? "BLOCKED" : standardMode && strict ? "PASS" : "BLOCKED",
    autoMode
      ? "Selected Auto Mode NodeClass startup policy requires private review and live startup probe"
      : standardMode && strict
        ? "VPC CNI strict startup mode observed"
        : "Selected VPC CNI mode or strict startup setting not confirmed",
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
  const crdsReady =
    crds?.length === 3 &&
    crds.every(
      (crd, index) =>
        crd?.metadata?.name ===
          `${["paseoprojects", "paseoworkspaces", "paseocredentialprofiles"][index]}.paseo-gateway.manziman.github.io` &&
        crd?.spec?.group === "paseo-gateway.manziman.github.io" &&
        crd?.spec?.scope === "Namespaced" &&
        crd?.spec?.versions?.some(
          (version) => version.name === "v1alpha1" && version.served && version.storage,
        ) &&
        crd?.status?.conditions?.some(
          (condition) => condition.type === "Established" && condition.status === "True",
        ),
    );
  add(
    "required-crds",
    crdsReady ? "PASS" : "BLOCKED",
    crdsReady
      ? "Three expected namespaced CRDs serve v1alpha1 and are Established; compare schemas separately"
      : "Three expected namespaced v1alpha1 CRDs must be Established before fixture use",
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
  const specificSelector = (selector) =>
    (selector?.matchLabels && Object.keys(selector.matchLabels).length > 0) ||
    (Array.isArray(selector?.matchExpressions) && selector.matchExpressions.length > 0);
  const narrowCidr = (cidr) => {
    if (typeof cidr !== "string") return false;
    const [address, prefix, extra] = cidr.split("/");
    const family = isIP(address);
    const bits = Number(prefix);
    return (
      !extra &&
      (family === 4 || family === 6) &&
      /^\d+$/.test(prefix ?? "") &&
      bits > 0 &&
      bits <= (family === 4 ? 32 : 128)
    );
  };
  const scopedRule = (rule) =>
    Array.isArray(rule?.to) &&
    rule.to.length > 0 &&
    rule.to.every(
      (target) =>
        specificSelector(target?.namespaceSelector) ||
        specificSelector(target?.podSelector) ||
        narrowCidr(target?.ipBlock?.cidr),
    ) &&
    Array.isArray(rule?.ports) &&
    rule.ports.length > 0 &&
    rule.ports.every((port) => port?.port !== undefined && port?.protocol === "TCP");
  const rules = [
    ...(Array.isArray(egressRules) ? egressRules : []),
    ...(Array.isArray(profileRules) ? profileRules.flatMap((profile) => profile.rules ?? []) : []),
  ];
  add(
    "configured-egress",
    egress && rules.length > 0 && rules.every(scopedRule) ? "PASS" : "BLOCKED",
    egress && rules.length > 0 && rules.every(scopedRule)
      ? "Outbound rules are destination- and TCP-port-scoped; approval and enforcement require live review"
      : "Outbound rules must explicitly scope destinations and TCP ports; empty or all-destination rules do not qualify",
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
    values.transport.tls.workspaceSecret.length > 0 &&
    values.transport.tls.gatewaySecret !== values.transport.tls.workspaceSecret;
  add(
    "chart-transport-tls",
    tlsRequested ? "PASS" : "BLOCKED",
    tlsRequested
      ? "Chart TLS and two Secret names configured; Secret keys, trust and handshake require live validation"
      : "TLS and distinct gateway/workspace Secret names required in local values",
  );
  const hosts = values?.gateway?.allowedHosts;
  const approvedHost =
    typeof hosts === "string" &&
    hosts
      .split(",")
      .map((host) => host.trim())
      .some((host) => host && !["localhost", "127.0.0.1", "::1", "*"].includes(host));
  add(
    "gateway-host-allowlist",
    approvedHost ? "PASS" : "BLOCKED",
    approvedHost
      ? "An explicit non-loopback gateway host is configured; ingress and TLS identity still need validation"
      : "Set an explicit approved ingress host; chart localhost defaults are insufficient",
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
    networkMode: options["network-mode"],
    crds,
    permissions,
    values,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.checks.some((check) => check.status === "BLOCKED") ? 1 : 0;
}

if (process.argv[1]?.endsWith("eks-preflight.mjs")) main();
