import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) throw new Error("Repository initialization failed");
}

async function attachReferenceCache(referencePath, workspace) {
  // A reference is an optional read-only optimization; malformed/absent caches are cold starts.
  const reference = spawnSync(
    "git",
    [
      "-c",
      `safe.directory=${referencePath}`,
      "-C",
      referencePath,
      "rev-parse",
      "--git-path",
      "objects",
    ],
    {
      encoding: "utf8",
    },
  );
  const shallow = spawnSync(
    "git",
    [
      "-c",
      `safe.directory=${referencePath}`,
      "-C",
      referencePath,
      "rev-parse",
      "--is-shallow-repository",
    ],
    {
      encoding: "utf8",
    },
  );
  if (reference.status !== 0 || shallow.status !== 0 || shallow.stdout.trim() !== "false")
    return false;
  const objects = resolve(referencePath, reference.stdout.trim());
  try {
    if (!(await stat(objects)).isDirectory()) return false;
  } catch {
    return false;
  }
  await mkdir(`${workspace}/.git/objects/info`, { recursive: true });
  await writeFile(`${workspace}/.git/objects/info/alternates`, `${objects}\n`, { mode: 0o600 });
  return true;
}

export async function initialize(dataRoot = "/data", referencePath = "/reference/git") {
  await mkdir(`${dataRoot}/home/.paseo`, { recursive: true });
  await mkdir(`${dataRoot}/home/.claude`, { recursive: true });
  await mkdir(`${dataRoot}/workspace`, { recursive: true });
  const marker = `${dataRoot}/checkout-ready`;
  let initialized = false;
  try {
    await readFile(marker);
    initialized = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!initialized) {
    const repository = process.env.REPOSITORY;
    let validRepository = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(repository || "");
    if (!validRepository) {
      const url = new URL(repository);
      validRepository =
        !url.search &&
        !url.hash &&
        !!url.hostname &&
        !!url.pathname.slice(1) &&
        ((url.protocol === "https:" && !url.username && !url.password) ||
          (url.protocol === "ssh:" && url.username === "git" && !url.password));
    }
    if (!validRepository || /\s/.test(repository))
      throw new Error("Invalid repository transport or embedded credentials");
    // init/fetch is safe to repeat after interrupted cloning and does not erase an existing working tree.
    git(["init", `${dataRoot}/workspace`]);
    const remote = spawnSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: `${dataRoot}/workspace`,
      encoding: "utf8",
    });
    if (remote.status !== 0) git(["remote", "add", "origin", repository], `${dataRoot}/workspace`);
    else if (remote.stdout.trim() !== repository)
      throw new Error("Existing repository origin does not match the project");
    const depth = process.env.FETCH_DEPTH ?? "1";
    if (!/^(0|[1-9][0-9]{0,5})$/.test(depth) || Number(depth) > 100000)
      throw new Error("Invalid fetch depth");
    const pullRequest = process.env.PULL_REQUEST;
    if (pullRequest && !/^[1-9][0-9]*$/.test(pullRequest))
      throw new Error("Invalid pull request number");
    const revision = pullRequest ? `refs/pull/${pullRequest}/head` : process.env.REVISION || "HEAD";
    if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}^~+-]*$/.test(revision)) throw new Error("Invalid revision");
    const usingCache = await attachReferenceCache(referencePath, `${dataRoot}/workspace`);
    const fetchArgs = [
      "fetch",
      "--no-recurse-submodules",
      ...(Number(depth) ? [`--depth=${depth}`] : []),
      "--",
      "origin",
      revision,
    ];
    try {
      git(fetchArgs, `${dataRoot}/workspace`);
    } catch (error) {
      if (!usingCache) throw error;
      await rm(`${dataRoot}/workspace/.git/objects/info/alternates`, { force: true });
      git(fetchArgs, `${dataRoot}/workspace`);
    }
    git(["checkout", "--detach", "FETCH_HEAD"], `${dataRoot}/workspace`);
    if (process.env.BRANCH) {
      git(["check-ref-format", "--branch", process.env.BRANCH], `${dataRoot}/workspace`);
      const exists = spawnSync(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${process.env.BRANCH}`],
        {
          cwd: `${dataRoot}/workspace`,
        },
      );
      git(
        exists.status === 0 ? ["switch", process.env.BRANCH] : ["switch", "-c", process.env.BRANCH],
        `${dataRoot}/workspace`,
      );
    }
    if (usingCache) {
      // Copy all reachable borrowed objects before marking checkout ready. No running workspace
      // depends on the cache's future availability, contents, or garbage collection policy.
      git(["repack", "-a", "-d"], `${dataRoot}/workspace`);
      await rm(`${dataRoot}/workspace/.git/objects/info/alternates`, { force: true });
    }
    await writeFile(`${marker}.tmp`, "initialized\n", { mode: 0o600 });
    await rename(`${marker}.tmp`, marker);
  }
  // The pod cannot create untracked workspaces through built-in Paseo agent tools.
  await writeFile(
    `${dataRoot}/home/.paseo/config.json.tmp`,
    JSON.stringify({
      daemon: { mcp: { enabled: false, injectIntoAgents: false }, relay: { enabled: false } },
    }),
    { mode: 0o600 },
  );

  await rename(`${dataRoot}/home/.paseo/config.json.tmp`, `${dataRoot}/home/.paseo/config.json`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await initialize();
