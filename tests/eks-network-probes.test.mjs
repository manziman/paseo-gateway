import assert from "node:assert/strict";
import test from "node:test";
import { fixtureMatches, grade, parseArgs } from "../scripts/eks-network-probes.mjs";

const options = {
  context: "explicit",
  namespace: "fixture",
  "namespace-uid": "namespace-uid",
  "run-label": "run-id",
  "source-pod": "source",
  "source-uid": "source-uid",
  "source-container": "probe",
  "control-pod": "control",
  "control-uid": "control-uid",
  "control-container": "probe",
  "allowed-ip": "10.0.0.1",
  "allowed-port": "443",
  "cross-workspace-ip": "10.0.0.2",
  "cross-workspace-port": "6768",
  "denied-ip": "10.0.0.3",
  "denied-port": "443",
};

test("network probes require explicit run gate, fixture identities, and numeric targets", () => {
  assert.throws(() => parseArgs([]), /gate/);
  assert.deepEqual(
    parseArgs([
      "--run-probes",
      ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, value]),
    ]),
    options,
  );
  assert.throws(
    () =>
      parseArgs([
        "--run-probes",
        ...Object.entries({ ...options, "denied-ip": "example.com" }).flatMap(([key, value]) => [
          `--${key}`,
          value,
        ]),
      ]),
    /numeric/,
  );
});

test("UID and ownership mismatch blocks all exec probes", () => {
  const label = { "paseo-gateway.manziman.github.io/qualification-run": "run-id" };
  const namespace = { metadata: { uid: "namespace-uid", labels: label } };
  const pod = (uid) => ({
    metadata: { uid, namespace: "fixture", labels: label },
    status: { phase: "Running" },
    spec: { hostNetwork: false, containers: [{ name: "probe" }] },
  });
  assert.ok(fixtureMatches(namespace, pod("source-uid"), pod("control-uid"), options));
  assert.ok(!fixtureMatches(namespace, pod("wrong"), pod("control-uid"), options));
  assert.ok(
    !fixtureMatches(
      namespace,
      pod("source-uid"),
      { ...pod("control-uid"), spec: { hostNetwork: true, containers: [{ name: "probe" }] } },
      options,
    ),
  );
});

test("a paired positive control is required to claim denied traffic", () => {
  const report = grade({
    allowed: "reachable",
    crossSource: "unreachable",
    crossControl: "unknown",
    deniedSource: "unreachable",
    deniedControl: "reachable",
    metadataSource: "unreachable",
    metadataControl: "unreachable",
  });
  assert.equal(
    report.checks.find((item) => item.id === "network.cross-workspace-denied")?.status,
    "BLOCKED",
  );
  assert.equal(
    report.checks.find((item) => item.id === "network.disallowed-egress-denied")?.status,
    "PASS",
  );
  assert.equal(report.checks.find((item) => item.id === "network.metadata-denied")?.status, "FAIL");
});
