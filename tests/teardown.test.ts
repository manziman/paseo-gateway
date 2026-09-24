import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const teardownUrl = new URL("../docker/teardown.mjs", import.meta.url);
const teardownModule = await import(teardownUrl.href);
const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(commands: string | string[]) {
  const path = await mkdtemp(join(tmpdir(), "gateway-teardown-test-"));
  directories.push(path);
  const checkout = join(path, "checkout");
  const dataHome = join(path, "home");
  await mkdir(checkout);
  await mkdir(dataHome);
  await writeFile(
    join(checkout, "paseo.json"),
    JSON.stringify({ worktree: { teardown: commands } }),
  );
  return { checkout, dataHome, env: { ...process.env, HOME: dataHome } };
}
describe("durable teardown hook fencing", () => {
  it("runs successful hooks exactly once even if the caller lost the first result", async () => {
    const f = await fixture("printf x >> effects");
    await teardownModule.teardownOnce(f.checkout, f.env);
    await teardownModule.teardownOnce(f.checkout, f.env);
    expect(await readFile(join(f.checkout, "effects"), "utf8")).toBe("x");
    expect(await readFile(join(f.dataHome, ".paseo/gateway-teardown-complete"), "utf8")).toBe(
      "complete\n",
    );
  });
  it("allows only one concurrent hook executor", async () => {
    const f = await fixture("printf x >> effects; sleep 0.1");
    const results = await Promise.allSettled([
      teardownModule.teardownOnce(f.checkout, f.env),
      teardownModule.teardownOnce(f.checkout, f.env),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await readFile(join(f.checkout, "effects"), "utf8")).toBe("x");
  });
  it("refuses automatic retry after nonzero exit because partial effects may exist", async () => {
    const f = await fixture("printf x >> effects; exit 7");
    await expect(teardownModule.teardownOnce(f.checkout, f.env)).rejects.toThrow();
    await expect(teardownModule.teardownOnce(f.checkout, f.env)).rejects.toThrow();
    expect(await readFile(join(f.checkout, "effects"), "utf8")).toBe("x");
    await expect(readFile(join(f.dataHome, ".paseo/gateway-teardown-complete"))).rejects.toThrow();
  });
  it("does not replay an intent left by a killed process", async () => {
    const f = await fixture("printf x >> effects");
    await mkdir(join(f.dataHome, ".paseo"));
    await writeFile(join(f.dataHome, ".paseo/gateway-teardown-started"), "started\n");
    await expect(teardownModule.teardownOnce(f.checkout, f.env)).rejects.toThrow();
    await expect(readFile(join(f.checkout, "effects"))).rejects.toThrow();
  });
  it("kills the hook process group on deadline and preserves the started intent", async () => {
    const f = await fixture("sleep 10");
    await expect(teardownModule.teardownOnce(f.checkout, f.env, 25)).rejects.toThrow("timed out");
    await expect(teardownModule.teardownOnce(f.checkout, f.env)).rejects.toThrow();
  });
  it("does not expose hook output or secret environment values through CLI errors", async () => {
    const f = await fixture("printf '%s' \"$PROVIDER_SECRET\" >&2; exit 2");
    const result = await execute(process.execPath, [teardownUrl.pathname], {
      cwd: f.checkout,
      env: { ...f.env, PROVIDER_SECRET: "credential-sentinel" },
    }).then(
      () => ({ stdout: "", stderr: "", code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Teardown failed; inspect repository hooks. Storage retained.\n");
    expect(JSON.stringify(result)).not.toContain("credential-sentinel");
  });
});
