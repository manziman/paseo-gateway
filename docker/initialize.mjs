import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) throw new Error("Repository initialization failed");
}

await mkdir("/data/home/.paseo", { recursive: true });
await mkdir("/data/home/.claude", { recursive: true });
await mkdir("/data/workspace", { recursive: true });
const marker = "/data/checkout-ready";
let initialized = false;
try {
  await readFile(marker);
  initialized = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!initialized) {
  const url = new URL(process.env.REPOSITORY);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("An HTTPS repository without embedded credentials is required");
  // init/fetch is safe to repeat after interrupted cloning and does not erase an existing working tree.
  git(["init", "/data/workspace"]);
  const remote = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: "/data/workspace",
    encoding: "utf8",
  });
  if (remote.status !== 0) git(["remote", "add", "origin", url.toString()], "/data/workspace");
  git(["fetch", "--depth=1", "origin", process.env.REVISION || "HEAD"], "/data/workspace");
  git(["checkout", "--detach", "FETCH_HEAD"], "/data/workspace");
  if (process.env.BRANCH) {
    git(["check-ref-format", "--branch", process.env.BRANCH], "/data/workspace");
    const exists = spawnSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${process.env.BRANCH}`],
      {
        cwd: "/data/workspace",
      },
    );
    git(
      exists.status === 0 ? ["switch", process.env.BRANCH] : ["switch", "-c", process.env.BRANCH],
      "/data/workspace",
    );
  }
  await writeFile(`${marker}.tmp`, "initialized\n", { mode: 0o600 });
  await rename(`${marker}.tmp`, marker);
}
// The pod cannot create untracked workspaces through built-in Paseo agent tools.
await writeFile(
  "/data/home/.paseo/config.json.tmp",
  JSON.stringify({
    daemon: { mcp: { enabled: false, injectIntoAgents: false }, relay: { enabled: false } },
  }),
  { mode: 0o600 },
);

await rename("/data/home/.paseo/config.json.tmp", "/data/home/.paseo/config.json");
