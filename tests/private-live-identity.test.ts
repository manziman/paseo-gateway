import { expect, it } from "vitest";
import { privateWorkerWorkspace } from "../scripts/private-live-identity.js";
import { workspace } from "./fixtures.js";

it("resolves a native GUID worker using its explicit workspace membership", () => {
  const worker = workspace("worker");
  expect(
    privateWorkerWorkspace(
      { id: "bc9ac495-aac7-48b1-aeca-a1ba7dcae436", workspaceId: "worker" },
      [worker],
      worker.spec.projectRef,
      "orchestrator",
    ),
  ).toBe(worker);
});

it("refuses same-workspace or foreign-project workers even when their GUID differs", () => {
  const worker = workspace("worker");
  const agent = { id: "bc9ac495-aac7-48b1-aeca-a1ba7dcae436", workspaceId: "worker" };
  expect(() => privateWorkerWorkspace(agent, [worker], worker.spec.projectRef, "worker")).toThrow(
    /separate workspace/,
  );
  expect(() => privateWorkerWorkspace(agent, [worker], "foreign", "orchestrator")).toThrow(
    /selected project/,
  );
});

it("does not infer workspace membership from a legacy-looking ID without metadata", () => {
  const worker = workspace("worker");
  expect(() =>
    privateWorkerWorkspace({ id: "worker~native-id" }, [worker], worker.spec.projectRef, "parent"),
  ).toThrow(/workspace membership/);
});
