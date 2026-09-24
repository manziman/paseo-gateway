import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureMatches, parseArgs } from "../scripts/local-transport-probe.mjs";

const args = [
  "--run-local-probe",
  "--context",
  "explicit-context",
  "--namespace",
  "fixture",
  "--gateway-pod",
  "gateway",
  "--workspace-pod",
  "workspace",
];

test("local TLS probe requires explicit context and distinct fixture Pods", () => {
  assert.throws(() => parseArgs(args.slice(1)));
  assert.throws(() => parseArgs(args.slice(0, -2)));
  assert.throws(() => parseArgs([...args.slice(0, -1), "gateway"]));
  assert.equal(parseArgs(args).context, "explicit-context");
});

test("local TLS probe only executes against owned ready Pods and TLS Service", () => {
  const options = parseArgs(args);
  const metadata = (name, component) => ({
    name,
    namespace: "fixture",
    uid: `uid-${name}`,
    labels: { "app.kubernetes.io/component": component, fixture: "owned" },
  });
  const ready = { phase: "Running", conditions: [{ type: "Ready", status: "True" }] };
  const gateway = {
    metadata: metadata("gateway", "gateway"),
    spec: { containers: [{ name: "gateway" }] },
    status: ready,
  };
  const workspace = {
    metadata: metadata("workspace", "workspace"),
    spec: { containers: [{ name: "daemon" }, { name: "transport" }] },
    status: { ...ready, podIP: "10.0.0.4" },
  };
  const service = {
    metadata: { name: "workspace", namespace: "fixture" },
    spec: {
      selector: { "app.kubernetes.io/component": "workspace", fixture: "owned" },
      ports: [{ port: 6767, targetPort: 6768 }],
    },
  };
  assert.equal(fixtureMatches(gateway, workspace, service, options), true);
  assert.equal(
    fixtureMatches(
      gateway,
      { ...workspace, status: { ...workspace.status, phase: "Pending" } },
      service,
      options,
    ),
    false,
  );
  assert.equal(
    fixtureMatches(
      gateway,
      workspace,
      { ...service, spec: { ...service.spec, ports: [{ port: 6767, targetPort: 6767 }] } },
      options,
    ),
    false,
  );
  assert.equal(
    fixtureMatches(
      gateway,
      workspace,
      { ...service, spec: { ...service.spec, selector: { fixture: "other" } } },
      options,
    ),
    false,
  );
});
