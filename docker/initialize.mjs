import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkoutBudget } from "./checkout-budget.mjs";
import {
  CheckoutFailure,
  classifyGitFailure,
  fetchWithRetry,
  MAX_FETCH_ATTEMPTS,
  terminationMessage,
} from "./checkout-failure.mjs";

function safeFailure(error) {
  if (error instanceof CheckoutFailure) return error;
  const code = ["ENOSPC", "EROFS", "EACCES", "EPERM"].includes(error?.code)
    ? "CheckoutLocalStorageFailed"
    : "CheckoutInitializationFailed";
  return new CheckoutFailure("prepare", code);
}

function git(args, cwd, stage = "checkout") {
  const result = spawnSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  if (result.status !== 0) throw classifyGitFailure(result, stage);
}

async function fetch(args, cwd, budget) {
  await fetchWithRetry(() => budget.run(args, cwd), {
    deadline: budget.deadline,
    attemptOffset: budget.attempts,
  });
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

async function initializeInternal(dataRoot, referencePath, budgetPath) {
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
    const budget = await checkoutBudget(budgetPath);
    try {
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
        throw new CheckoutFailure("prepare", "CheckoutConfigurationInvalid");
      // init/fetch is safe to repeat after interrupted cloning and does not erase an existing working tree.
      git(["init", `${dataRoot}/workspace`], undefined, "prepare");
      const remote = spawnSync("git", ["config", "--get", "remote.origin.url"], {
        cwd: `${dataRoot}/workspace`,
        encoding: "utf8",
      });
      if (remote.status !== 0)
        git(["remote", "add", "origin", repository], `${dataRoot}/workspace`, "prepare");
      else if (remote.stdout.trim() !== repository)
        throw new CheckoutFailure("prepare", "CheckoutConfigurationInvalid");
      const depth = process.env.FETCH_DEPTH ?? "1";
      if (!/^(0|[1-9][0-9]{0,5})$/.test(depth) || Number(depth) > 100000)
        throw new CheckoutFailure("prepare", "CheckoutConfigurationInvalid");
      const pullRequest = process.env.PULL_REQUEST;
      if (pullRequest && !/^[1-9][0-9]*$/.test(pullRequest))
        throw new CheckoutFailure("prepare", "CheckoutConfigurationInvalid");
      const revision = pullRequest
        ? `refs/pull/${pullRequest}/head`
        : process.env.REVISION || "HEAD";
      if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}^~+-]*$/.test(revision))
        throw new CheckoutFailure("prepare", "CheckoutConfigurationInvalid");
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
        await fetch(fetchArgs, `${dataRoot}/workspace`, budget);
      } catch (error) {
        if (
          !usingCache ||
          !(error instanceof CheckoutFailure) ||
          error.code !== "CheckoutCacheInvalid" ||
          error.attempts >= MAX_FETCH_ATTEMPTS
        )
          throw error;
        await rm(`${dataRoot}/workspace/.git/objects/info/alternates`, { force: true });
        await fetch(fetchArgs, `${dataRoot}/workspace`, budget);
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
          exists.status === 0
            ? ["switch", process.env.BRANCH]
            : ["switch", "-c", process.env.BRANCH],
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
    } catch (error) {
      const failure = safeFailure(error);
      failure.attempts = budget.attempts;
      await budget.fail(failure);
      throw failure;
    }
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

export async function initialize(
  dataRoot = "/data",
  referencePath = "/reference/git",
  budgetPath = "/tmp/paseo-checkout-budget/state.json",
) {
  try {
    await initializeInternal(dataRoot, referencePath, budgetPath);
  } catch (error) {
    throw safeFailure(error);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await initialize();
  } catch (error) {
    const diagnostic = terminationMessage(error);
    await writeFile("/dev/termination-log", diagnostic, { mode: 0o600 }).catch(() => {});
    console.error(diagnostic);
    process.exitCode = 1;
  }
}
