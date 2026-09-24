#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cliTarget } from "./cli-target.mjs";

// The original upstream CLI remains untouched; this entry point supplies cluster routing.
const args = process.argv.slice(2);
const env = { ...process.env };
let command;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (["--host", "--home", "--timeout"].includes(arg)) {
    index++;
    continue;
  }
  if (arg.startsWith("-")) continue;
  command = arg;
  break;
}
if (env.PASEO_GATEWAY_URL) {
  if (args.some((arg) => arg === "--home" || arg.startsWith("--home="))) {
    process.stderr.write("Use the Kubernetes gateway; local daemon ownership is disabled.\n");
    process.exit(2);
  }
  env.PASEO_PASSWORD = readFileSync(env.PASEO_GATEWAY_TOKEN_FILE, "utf8").trim();
  if (!args.some((arg) => arg === "--host" || arg.startsWith("--host=")))
    args.unshift("--host", cliTarget(env.PASEO_GATEWAY_URL));
  const workspace = env.PASEO_CLUSTER_WORKSPACE_ID;
  if (workspace) {
    env.PASEO_WORKSPACE_ID = workspace;
    if (env.PASEO_AGENT_ID) {
      if (command === "heartbeat") {
        // Heartbeat sends this value as a schedule target, whose pinned wire
        // contract requires the daemon's bare UUID. Other CLI commands route
        // scoped IDs through the gateway as before.
        if (env.PASEO_AGENT_ID.includes("~")) {
          const [route, encoded, extra] = env.PASEO_AGENT_ID.split("~");
          const nativeId = encoded ? Buffer.from(encoded, "base64url").toString() : "";
          if (
            route !== workspace ||
            extra !== undefined ||
            !/^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(nativeId) ||
            Buffer.from(nativeId).toString("base64url") !== encoded
          ) {
            process.stderr.write("Heartbeat agent does not belong to this workspace.\n");
            process.exit(2);
          }
          env.PASEO_AGENT_ID = nativeId;
        }
      } else if (!env.PASEO_AGENT_ID.includes("~"))
        env.PASEO_AGENT_ID = `${workspace}~${Buffer.from(env.PASEO_AGENT_ID).toString("base64url")}`;
    }
  }
  // A plain in-agent `run` creates isolated sibling compute; explicit reuse remains supported.
  if (command === "run" && !args.some((arg) => /^(--workspace|--new-workspace)(=|$)/.test(arg))) {
    args.push("--new-workspace", "worktree");
    if (!args.some((arg) => /^--cwd(=|$)/.test(arg)))
      args.push("--cwd", `/projects/${env.PASEO_CLUSTER_PROJECT_ID}`);
  }
}
const child = spawn("/usr/local/bin/paseo", args, { env, stdio: "inherit" });
child.once("error", () => {
  process.stderr.write("Cannot start Paseo CLI\n");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
