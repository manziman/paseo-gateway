#!/usr/bin/env node
import { spawn } from "node:child_process";
import { githubEnvironment } from "/opt/paseo/token-file.mjs";

try {
  const env = githubEnvironment();
  const child = spawn("/usr/bin/gh", process.argv.slice(2), { env, stdio: "inherit" });
  child.on("error", () => {
    process.stderr.write("GitHub CLI unavailable\n");
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} catch {
  process.stderr.write("GitHub credentials unavailable\n");
  process.exitCode = 1;
}
