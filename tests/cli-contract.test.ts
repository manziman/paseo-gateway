import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AgentSnapshotPayloadSchema,
  type SessionInboundMessage,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { expect, it } from "vitest";
import { scopedId } from "../src/domain.js";
import { workspaceDescriptor } from "../src/gateway/catalog.js";
import { startGateway } from "../src/gateway/server.js";
import { MemoryStore, project, workspace } from "./fixtures.js";

/** Run the unmodified pinned upstream executable; its daemon backend is a deterministic fixture.
 * Set PASEO_CLI_BIN to @getpaseo/cli@0.9.1's bin/paseo. Real providers remain live-suite coverage.
 */
it.skipIf(!process.env.PASEO_CLI_BIN)(
  "upstream CLI --host JSON lifecycle, labels, env, permissions and provider contract",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cli-test-"));
    const preload = join(home, "short-legacy-timeout.mjs");
    await writeFile(
      preload,
      `const original=globalThis.setTimeout; globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===60000?100:ms,...args);`,
    );
    const store = new MemoryStore();
    store.workspaceRows = [workspace("one"), workspace("two")];
    const requests: SessionInboundMessage[] = [];
    const agents = new Map(
      store.workspaceRows.map((row) => [
        row.metadata.name,
        AgentSnapshotPayloadSchema.parse({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          provider: "claude",
          cwd: `/workspaces/${row.metadata.name}`,
          workspaceId: "local",
          model: null,
          createdAt: "2026-09-24T00:00:00Z",
          updatedAt: "2026-09-24T00:00:00Z",
          lastUserMessageAt: null,
          status: "idle",
          capabilities: {
            supportsStreaming: true,
            supportsSessionPersistence: true,
            supportsDynamicModes: true,
            supportsMcpServers: true,
            supportsReasoningStream: true,
            supportsToolInvocations: true,
          },
          currentModeId: "default",
          availableModes: [],
          pendingPermissions: [
            {
              id: `permission-${row.metadata.name}`,
              provider: "claude",
              kind: "tool",
              name: "Bash",
            },
          ],
          persistence: null,
          title: row.metadata.name,
          labels: { role: "worker" },
        }),
      ]),
    );
    const gateway = await startGateway({
      store,
      operations: {
        creationLifecycle: true,
        async handle() {
          return false;
        },
      },
      namespace: "test",
      backendPassword: "fixture",
      password: "fixture-password",
      serverId: "contract",
      host: "127.0.0.1",
      port: 0,
      allowedHosts: ["127.0.0.1"],
      ready: async () => true,
      backendFactory: (row) => ({
        async connect() {},
        async close() {},
        binary() {},
        send(message) {
          requests.push(message);
        },
        async request(message) {
          requests.push(message);
          const agent = agents.get(row.metadata.name);
          if (!agent) throw new Error("Missing fixture");
          const requestId = "requestId" in message ? message.requestId : undefined;
          const payload = { requestId, agentId: agent.id, agent, error: null };
          const reply = (type: string, values: object) =>
            SessionOutboundMessageSchema.parse({ type, payload: { requestId, ...values } });
          if (message.type === "open_project_request")
            return reply("open_project_response", {
              workspace: { ...workspaceDescriptor(row, project()), id: "local" },
              error: null,
            });
          if (message.type === "fetch_workspaces_request")
            return reply("fetch_workspaces_response", {
              entries: [],
              emptyProjects: [],
              subscriptionId: null,
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            });
          if (message.type === "fetch_agents_request")
            return reply("fetch_agents_response", {
              entries: [
                {
                  agent,
                  project: {
                    projectKey: "local",
                    projectName: "Example",
                    checkout: {
                      cwd: agent.cwd,
                      isGit: true,
                      currentBranch: "main",
                      isPaseoOwnedWorktree: false,
                      remoteUrl: null,
                    },
                  },
                },
              ],
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            });
          if (message.type === "fetch_agent_request") return reply("fetch_agent_response", payload);
          if (message.type === "cancel_agent_request")
            return reply("cancel_agent_response", payload);
          if (message.type === "send_agent_message_request")
            return reply("send_agent_message_response", { ...payload, accepted: true });
          if (message.type === "wait_for_finish_request")
            return reply("wait_for_finish_response", {
              status: "idle",
              final: agent,
              error: null,
              lastMessage: "done",
            });
          if (message.type === "archive_agent_request") {
            agent.archivedAt = new Date().toISOString();
            return reply("agent_archived", { agentId: agent.id, archivedAt: agent.archivedAt });
          }
          if (message.type === "refresh_agent_request")
            return reply("status", {
              status: "agent_refreshed",
              agentId: agent.id,
              timelineSize: 0,
            });
          if (message.type === "update_agent_request") {
            if (message.labels) agent.labels = message.labels;
            if (message.name) agent.title = message.name;
            return reply("update_agent_response", {
              agentId: agent.id,
              accepted: true,
              error: null,
            });
          }
          if (message.type === "agent.create.request") {
            await new Promise((resolve) => setTimeout(resolve, 300));
            agent.labels = message.labels;
            return reply("agent.create.response", { agent, error: null });
          }
          if (
            message.type === "get_providers_snapshot_request" ||
            message.type === "refresh_providers_snapshot_request"
          )
            return reply(message.type.replace("_request", "_response"), {
              entries: [],
              generatedAt: new Date().toISOString(),
            });
          if (message.type === "list_provider_models_request")
            return reply("list_provider_models_response", {
              provider: message.provider,
              models: [],
              error: null,
              fetchedAt: new Date().toISOString(),
            });
          if (message.type === "provider_diagnostic_request")
            return reply("provider_diagnostic_response", {
              provider: message.provider,
              diagnostic: "fixture runtime installed",
            });
          throw new Error(`Unexpected fixture RPC ${message.type}`);
        },
      }),
    });
    try {
      const address = gateway.server.address();
      if (!address || typeof address === "string") throw new Error("Missing listener");
      const { cliTarget } = await import(new URL("../docker/cli-target.mjs", import.meta.url).href);
      const target = cliTarget(`ws://127.0.0.1:${address.port}/ws`);
      const cli = async (...args: string[]) => {
        const result = await promisify(execFile)(
          process.execPath,
          [process.env.PASEO_CLI_BIN ?? "", ...args, "--host", target, "--json"],
          {
            timeout: 15000,
            env: {
              ...process.env,
              NODE_OPTIONS: args[0] === "run" ? `--import ${preload}` : undefined,
              HOME: home,
              PASEO_HOME: join(home, ".paseo"),
              PASEO_PASSWORD: "fixture-password",
              PASEO_HOST: undefined,
              PASEO_AGENT_ID: undefined,
              PASEO_WORKSPACE_ID: undefined,
            },
          },
        );
        return JSON.parse(result.stdout);
      };
      const id = scopedId("one", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      const list = await cli("ls", "-g", "-a");
      expect(JSON.stringify(list)).toContain(id);
      expect(JSON.stringify(await cli("permit", "ls"))).toContain(
        scopedId("two", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      );
      await cli("provider", "ls");
      expect(await cli("daemon", "status")).toMatchObject({
        connectedDaemon: "reachable",
        daemonVersion: "0.1.0-poc.1",
        workerPid: process.pid,
        providers: [],
      });
      await cli("provider", "models", "codex");
      expect(JSON.stringify(await cli("provider", "diagnostic", "codex"))).toContain(
        "fixture runtime installed",
      );
      await cli("permit", "deny", id, "--all");
      expect(requests).toContainEqual(
        expect.objectContaining({
          type: "agent_permission_response",
          agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          requestId: "permission-one",
          response: { behavior: "deny" },
        }),
      );
      await cli(
        "run",
        "--workspace",
        "one",
        "--provider",
        "codex",
        "--env",
        "IDENTITY=worker",
        "--label",
        "role=reviewer",
        "--background",
        "fixture prompt",
      );
      expect(requests).toContainEqual(
        expect.objectContaining({
          type: "agent.create.request",
          workspaceId: "local",
          config: expect.objectContaining({ provider: "codex" }),
          env: { IDENTITY: "worker" },
          labels: { role: "reviewer" },
        }),
      );
      await cli("wait", id, "--timeout", "1");
      await cli("send", id, "follow up");
      await cli("stop", id);
      await cli("agent", "reload", id);
      await cli("agent", "update", id, "--label", "role=updated");
      expect(agents.get("one")?.labels).toEqual({ role: "updated" });
      await cli("archive", id);
      expect(agents.get("one")?.archivedAt).toBeTruthy();
    } finally {
      await gateway.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);
