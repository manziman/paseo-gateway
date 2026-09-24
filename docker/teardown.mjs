import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";

/** Run repository-defined hooks before the controller stops compute or releases storage. */
export async function teardown(cwd, env = process.env, timeoutMs = 60000) {
  let config;
  try {
    config = JSON.parse(await readFile(resolve(cwd, "paseo.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("Invalid paseo.json");
  }
  const raw = config.worktree?.teardown;
  const commands = typeof raw === "string" ? [raw] : (raw ?? []);
  if (!Array.isArray(commands) || commands.some((value) => typeof value !== "string"))
    throw new Error("Invalid teardown hook configuration");
  const deadline = Date.now() + timeoutMs;
  for (const command of commands.filter((value) => value.trim())) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Teardown timed out");
    await new Promise((accept, reject) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd,
        env: {
          ...env,
          PASEO_SOURCE_CHECKOUT_PATH: cwd,
          PASEO_ROOT_PATH: cwd,
          PASEO_WORKTREE_PATH: cwd,
        },
        stdio: "ignore",
        detached: true,
      });
      const timer = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
        reject(new Error("Teardown timed out"));
      }, remaining);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Teardown failed"));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) accept();
        else reject(new Error("Teardown failed; storage retained"));
      });
    });
  }
}

/** A retained intent fences concurrent calls and refuses replay after an ambiguous outcome. */
export async function teardownOnce(cwd, env = process.env, timeoutMs = 60000) {
  const directory = resolve(env.HOME, ".paseo");
  const marker = resolve(directory, "gateway-teardown-complete");
  try {
    await readFile(marker);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Keep this marker even on failure: hooks may have effects before a nonzero exit.
  const intent = await open(resolve(directory, "gateway-teardown-started"), "wx", 0o600);
  try {
    await intent.writeFile("started; inspect side effects before any manual retry\n");
    await intent.sync();
  } finally {
    await intent.close();
  }
  const intentDirectory = await open(directory, "r");
  try {
    await intentDirectory.sync();
  } finally {
    await intentDirectory.close();
  }
  await teardown(cwd, env, timeoutMs);
  const completed = await open(`${marker}.tmp`, "wx", 0o600);
  try {
    await completed.writeFile("complete\n");
    await completed.sync();
  } finally {
    await completed.close();
  }
  await rename(`${marker}.tmp`, marker);
  const completedDirectory = await open(directory, "r");
  try {
    await completedDirectory.sync();
  } finally {
    await completedDirectory.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    await teardownOnce(process.cwd());
  } catch {
    process.stderr.write("Teardown failed; inspect repository hooks. Storage retained.\n");
    process.exitCode = 1;
  }
}
