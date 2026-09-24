import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";
import { type ScheduleDispatch, ScheduleService } from "../src/gateway/schedules.js";
import { startGateway } from "../src/gateway/server.js";
import { MemoryStore } from "./fixtures.js";
import { MemoryRecordStore } from "./record-store.js";

/** Official 0.9.1 CLI executable -> real gateway -> real durable scheduler.
 * Only the provider dispatch/observation and Kubernetes API are fixtures.
 */
it.skipIf(!process.env.PASEO_CLI_BIN)(
  "official CLI schedule lifecycle, provider flags, run logs and mutation failures",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cli-schedules-"));
    const store = new MemoryStore();
    const records = new MemoryRecordStore();
    const dispatched: ScheduleDispatch[] = [];
    let complete = false;
    const schedules = new ScheduleService({
      store,
      records,
      now: () => new Date("2026-09-24T00:00:00Z"),
      dispatch: async (input) => {
        dispatched.push(input);
        return { workspaceId: "schedule-worker", agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
      },
      observe: async () =>
        complete ? { status: "succeeded", output: "fixture scheduled result" } : undefined,
    });
    await schedules.initialize();
    const gateway = await startGateway({
      store,
      namespace: "test",
      backendPassword: "fixture-backend-password",
      password: "fixture-owner-password",
      serverId: "cli-schedule-contract",
      host: "127.0.0.1",
      port: 0,
      allowedHosts: ["127.0.0.1"],
      ready: async () => true,
      operations: {
        handle: (message, emit, principal) => schedules.handle(message, emit, principal),
      },
    });
    try {
      const address = gateway.server.address();
      if (!address || typeof address === "string") throw new Error("Missing test listener");
      const cli = async (...args: string[]): Promise<unknown> => {
        const result = await promisify(execFile)(
          process.execPath,
          [
            process.env.PASEO_CLI_BIN ?? "",
            "schedule",
            ...args,
            "--host",
            `tcp://127.0.0.1:${address.port}`,
            "--json",
          ],
          {
            timeout: 15000,
            env: {
              ...process.env,
              HOME: home,
              PASEO_HOME: join(home, ".paseo"),
              PASEO_PASSWORD: "fixture-owner-password",
              PASEO_HOST: undefined,
              PASEO_AGENT_ID: undefined,
              PASEO_WORKSPACE_ID: undefined,
            },
          },
        );
        return JSON.parse(result.stdout);
      };
      expect(await cli("ls")).toEqual([]);
      const created = await cli(
        "create",
        "Perform fixture work",
        "--every",
        "5m",
        "--name",
        "cli-contract",
        "--provider",
        "codex/fixture-model",
        "--thinking",
        "high",
        "--cwd",
        "/projects/example",
        "--max-runs",
        "3",
      );
      const { id } = z.object({ id: z.string().uuid() }).parse(created);
      expect(created).toMatchObject({
        name: "cli-contract",
        cadence: "cron:*/5 * * * *",
        target: "new-agent:codex/fixture-model",
        status: "active",
      });
      expect(await cli("ls")).toEqual([expect.objectContaining({ id })]);
      expect(await cli("inspect", id)).toMatchObject({
        id,
        prompt: "Perform fixture work",
        maxRuns: 3,
        target: {
          type: "new-agent",
          config: {
            provider: "codex",
            model: "fixture-model",
            thinkingOptionId: "high",
            cwd: "/projects/example",
          },
        },
      });
      expect(await cli("logs", id)).toEqual([]);
      expect(
        await cli(
          "update",
          id,
          "--prompt",
          "Updated fixture prompt",
          "--name",
          "updated-contract",
          "--cron",
          "0 * * * *",
          "--timezone",
          "America/Chicago",
          "--provider",
          "claude/fixture-next",
          "--mode",
          "bypassPermissions",
          "--max-runs",
          "2",
        ),
      ).toMatchObject({
        id,
        name: "updated-contract",
        prompt: "Updated fixture prompt",
        maxRuns: 2,
        cadence: { type: "cron", expression: "0 * * * *", timezone: "America/Chicago" },
        target: {
          config: { provider: "claude", model: "fixture-next", modeId: "bypassPermissions" },
        },
      });
      expect(await cli("pause", id)).toMatchObject({ id, status: "paused", nextRunAt: null });
      await schedules.tick();
      expect(dispatched).toHaveLength(0);
      expect(await cli("resume", id)).toMatchObject({ id, status: "active" });
      expect(await cli("run-once", id)).toMatchObject({ id, status: "active" });
      await expect.poll(() => dispatched.length).toBe(1);
      expect(dispatched[0]).toMatchObject({
        projectId: "example",
        credentialProfile: "claude-default",
        schedule: {
          prompt: "Updated fixture prompt",
          target: { config: { model: "fixture-next" } },
        },
      });
      const logs = await cli("logs", id);
      expect(logs).toEqual([expect.objectContaining({ status: "running", agentId: "aaaaaaa" })]);
      await expect(cli("delete", id)).rejects.toMatchObject({ code: 1 });
      expect(await records.records("schedule")).toHaveLength(1);
      complete = true;
      await schedules.tick();
      await expect
        .poll(
          async () =>
            (await records.record<{ reservations: unknown[] }>("schedule", id))?.value.reservations
              .length,
        )
        .toBe(0);
      expect(await cli("logs", id)).toEqual([
        expect.objectContaining({
          status: "succeeded",
          output: "fixture scheduled result",
          error: null,
        }),
      ]);
      expect(await cli("delete", id)).toMatchObject({ id });
      expect(await cli("ls")).toEqual([]);
      expect(await records.records("schedule-run")).toHaveLength(0);
      await expect(cli("inspect", id)).rejects.toMatchObject({ code: 1 });
      await expect(
        cli(
          "create",
          "Invalid binding",
          "--every",
          "5m",
          "--provider",
          "claude",
          "--cwd",
          "/unconfigured-project",
        ),
      ).rejects.toMatchObject({ code: 1 });
      await expect(
        cli(
          "create",
          "Unsupported target",
          "--every",
          "5m",
          "--target",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "--cwd",
          "/projects/example",
        ),
      ).rejects.toMatchObject({ code: 1 });
      expect(await records.records("schedule")).toHaveLength(0);
      expect(dispatched).toHaveLength(1);
    } finally {
      await schedules.close();
      await gateway.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  90000,
);
