import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Keep the pinned official CLI separate from the user's installation and runtime dependencies. */
async function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
}

const directory = await mkdtemp(join(tmpdir(), "paseo-pinned-cli-"));
try {
  await run(
    "npm",
    [
      "install",
      "--prefix",
      directory,
      "--ignore-scripts",
      "--save-exact",
      "--no-audit",
      "--no-fund",
      "@getpaseo/cli@0.9.1",
    ],
    { ...process.env, ONNXRUNTIME_NODE_INSTALL: "skip" },
  );
  await run(
    "npm",
    ["exec", "--", "vitest", "run", "tests/cli-contract.test.ts", "tests/cli-schedules.test.ts"],
    {
      ...process.env,
      PASEO_CLI_BIN: join(directory, "node_modules/@getpaseo/cli/bin/paseo"),
    },
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
