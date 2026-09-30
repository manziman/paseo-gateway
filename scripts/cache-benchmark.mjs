// Offline, disposable fixture; reports timings without reading user repositories or credentials.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "paseo-cache-benchmark-"));
const env = {
  PATH: process.env.PATH,
  HOME: root,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Benchmark",
  GIT_AUTHOR_EMAIL: "benchmark@example.com",
  GIT_COMMITTER_NAME: "Benchmark",
  GIT_COMMITTER_EMAIL: "benchmark@example.com",
};
function git(args, cwd = root) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Fixture git operation failed");
  return result.stdout.trim();
}
try {
  const source = join(root, "source");
  const cache = join(root, "cache.git");
  git(["init", "--initial-branch=main", source]);
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(source, `fixture-${i}.bin`), randomBytes(4 * 1024 * 1024));
    git(["add", "."], source);
    git(["commit", "-m", `fixture ${i}`], source);
  }
  git(["clone", "--mirror", source, cache]);
  const measurements = [];
  for (let run = 0; run < 3; run++) {
    for (const mode of ["cold", "reference"]) {
      const data = join(root, `${mode}-${run}`);
      const script = `import { initialize } from ${JSON.stringify(pathToFileURL(resolve("docker/initialize.mjs")).href)}; await initialize(${JSON.stringify(data)}, ${JSON.stringify(mode === "reference" ? cache : join(root, "absent"))}, ${JSON.stringify(join(data, "pod-tmp", "checkout-budget.json"))});`;
      const started = performance.now();
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        env: {
          ...env,
          REPOSITORY: "https://github.com/fixture/cache.git",
          REVISION: "main",
          FETCH_DEPTH: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${pathToFileURL(source).href}.insteadOf`,
          GIT_CONFIG_VALUE_0: "https://github.com/fixture/cache.git",
        },
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error("Fixture checkout failed");
      measurements.push({
        mode,
        run: run + 1,
        milliseconds: Math.round(performance.now() - started),
      });
      git(["fsck", "--full"], join(data, "workspace"));
    }
  }
  process.stdout.write(
    `${JSON.stringify({ fixture: "6 commits, 24 MiB incompressible files, full history, local file transport", measurements }, null, 2)}\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
