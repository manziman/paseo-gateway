import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";
import { type ScheduleDispatch, ScheduleService } from "../src/gateway/schedules.js";
import { startGateway } from "../src/gateway/server.js";
import { MemoryStore, workspace } from "./fixtures.js";
import { MemoryRecordStore } from "./record-store.js";

/** Official 0.9.1 CLI executable -> real gateway -> real durable scheduler.
 * Only the provider dispatch/observation and Kubernetes API are fixtures.
 */
it.skipIf(!process.env.PASEO_CLI_BIN)(
  "official CLI schedule lifecycle, provider flags, run logs and mutation failures",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cli-schedules-"));
    const store = new MemoryStore();
    store.workspaceRows = [workspace()];
    const records = new MemoryRecordStore();
    const dispatched: ScheduleDispatch[] = [];
    const existingAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let complete = false;
    const schedules = new ScheduleService({
      store,
      records,
      now: () => new Date("2026-09-24T00:00:00Z"),
      resolveAgent: async (agentId) => {
        if (agentId !== existingAgentId) throw new Error("Scheduled target agent does not exist");
        return {
          projectId: "example",
          credentialProfile: "claude-default",
          workspaceId: "one",
          workspaceUid: "uid-one",
        };
      },
      dispatch: async (input) => {
        dispatched.push(input);
        return {
          workspaceId: input.targetWorkspaceId ?? "schedule-worker",
          agentId: existingAgentId,
        };
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
      const tokenFile = join(home, "gateway-token");
      const remapFile = join(home, "remap-cli.mjs");
      await writeFile(tokenFile, "fixture-owner-password\n", { mode: 0o600 });
      // Exercise the production wrapper against the official, unmodified CLI.
      // Remap only its image-local executable path in this test process.
      await writeFile(
        remapFile,
        `import childProcess from 'node:child_process';\nimport { syncBuiltinESMExports } from 'node:module';\nconst spawn = childProcess.spawn;\nchildProcess.spawn = (binary, args, options) => spawn(binary === '/usr/local/bin/paseo' ? process.env.PASEO_CLI_BIN : binary, args, options);\nsyncBuiltinESMExports();\n`,
      );
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
      const heartbeat = async (agentId: string, ...args: string[]): Promise<unknown> => {
        const result = await promisify(execFile)(
          process.execPath,
          [join(process.cwd(), "docker/paseo-cli.mjs"), "heartbeat", ...args, "--json"],
          {
            timeout: 15000,
            env: {
              ...process.env,
              HOME: home,
              PASEO_HOME: join(home, ".paseo"),
              PASEO_HOST: undefined,
              PASEO_GATEWAY_URL: `ws://127.0.0.1:${address.port}/ws`,
              PASEO_GATEWAY_TOKEN_FILE: tokenFile,
              PASEO_CLUSTER_WORKSPACE_ID: "one",
              PASEO_AGENT_ID: agentId,
              NODE_OPTIONS:
                `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(remapFile).href}`.trim(),
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
      const existing = await cli(
        "create",
        "Prompt the existing agent",
        "--every",
        "5m",
        "--target",
        existingAgentId,
        "--cwd",
        "/projects/example",
      );
      const existingScheduleId = z.object({ id: z.string().uuid() }).parse(existing).id;
      expect((await records.records("schedule"))[0]?.value).toMatchObject({
        targetWorkspaceId: "one",
        targetWorkspaceUid: "uid-one",
        schedule: { target: { type: "agent", agentId: existingAgentId } },
      });
      // The pinned CLI hides non-new-agent schedules from these commands even
      // though create/delete and the SDK protocol support them.
      expect(await cli("ls")).toEqual([]);
      await expect(cli("inspect", existingScheduleId)).rejects.toMatchObject({ code: 1 });
      await expect(cli("run-once", existingScheduleId)).rejects.toMatchObject({ code: 1 });
      expect(await cli("delete", existingScheduleId)).toMatchObject({ id: existingScheduleId });
      const scopedAgentId = `one~${Buffer.from(existingAgentId).toString("base64url")}`;
      const heartbeatCreated = await heartbeat(
        scopedAgentId,
        "create",
        "Keep this agent active",
        "--cron",
        "*/10 * * * *",
      );
      const heartbeatId = z.object({ id: z.string().uuid() }).parse(heartbeatCreated).id;
      expect((await records.record("schedule", heartbeatId))?.value).toMatchObject({
        targetWorkspaceId: "one",
        targetWorkspaceUid: "uid-one",
        schedule: { target: { type: "agent", agentId: existingAgentId } },
      });
      expect(
        await heartbeat(scopedAgentId, "update", heartbeatId, "--cron", "0 * * * *"),
      ).toMatchObject({ id: heartbeatId, cadence: "cron:0 * * * *" });
      expect(await heartbeat(scopedAgentId, "delete", heartbeatId)).toEqual({
        id: heartbeatId,
        status: "deleted",
      });
      expect(await records.record("schedule", heartbeatId)).toBeUndefined();
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
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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
