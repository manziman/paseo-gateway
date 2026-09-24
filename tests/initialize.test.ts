import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "paseo-checkout-test-"));
  roots.push(root);
  const source = join(root, "source");
  const data = join(root, "data");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  function git(args: string[], cwd = root) {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  git(["init", "--initial-branch=main", source]);
  writeFileSync(join(source, "file.txt"), "first\n");
  git(["add", "."], source);
  git(["commit", "-m", "first"], source);
  const first = git(["rev-parse", "HEAD"], source);
  writeFileSync(join(source, "file.txt"), "second\n");
  git(["commit", "-am", "second"], source);
  git(["update-ref", "refs/pull/7/head", first], source);
  function initialize(overrides: Record<string, string> = {}, referencePath?: string) {
    const script = `import { initialize } from ${JSON.stringify(pathToFileURL(resolve("docker/initialize.mjs")).href)}; await initialize(${JSON.stringify(data)}, ${JSON.stringify(referencePath)});`;
    return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: {
        ...env,
        REPOSITORY: "https://github.com/test/repo.git",
        REVISION: "main",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${pathToFileURL(source).href}.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://github.com/test/repo.git",
        ...overrides,
      },
    });
  }
  return { data, source, initialize, git, first };
}
describe("workspace checkout initialization", () => {
  it("creates a branch with bounded history and preserves dirty work on restart", () => {
    const fixture = setup();
    expect(fixture.initialize({ BRANCH: "feature/test" }).status).toBe(0);
    const cwd = join(fixture.data, "workspace");
    expect(fixture.git(["branch", "--show-current"], cwd)).toBe("feature/test");
    expect(fixture.git(["rev-list", "--count", "HEAD"], cwd)).toBe("1");
    writeFileSync(join(cwd, "file.txt"), "local work\n");
    expect(fixture.initialize({ REVISION: "missing" }).status).toBe(0);
    expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("local work\n");
  });
  it("fetches a pull request head independently of the requested base revision", () => {
    const fixture = setup();
    expect(fixture.initialize({ PULL_REQUEST: "7", BRANCH: "pr/7" }).status).toBe(0);
    expect(fixture.git(["rev-parse", "HEAD"], join(fixture.data, "workspace"))).toBe(fixture.first);
  });
  it("supports complete history when fetchDepth is zero", () => {
    const fixture = setup();
    expect(fixture.initialize({ FETCH_DEPTH: "0" }).status).toBe(0);
    expect(fixture.git(["rev-list", "--count", "HEAD"], join(fixture.data, "workspace"))).toBe("2");
  });
  it("retries an interrupted checkout without replacing its origin", () => {
    const fixture = setup();
    expect(fixture.initialize({ REVISION: "missing" }).status).not.toBe(0);
    expect(fixture.initialize().status).toBe(0);
  });
  it("dissociates borrowed cache objects so deleting the cache cannot damage a workspace", () => {
    const fixture = setup();
    const cache = `${fixture.source}-cache`;
    fixture.git(["clone", "--mirror", fixture.source, cache]);
    expect(fixture.initialize({ FETCH_DEPTH: "0", BRANCH: "feature/cached" }, cache).status).toBe(
      0,
    );
    const cwd = join(fixture.data, "workspace");
    expect(existsSync(join(cwd, ".git/objects/info/alternates"))).toBe(false);
    rmSync(cache, { recursive: true, force: true });
    expect(fixture.git(["fsck", "--full"], cwd)).not.toContain("missing");
    expect(fixture.git(["rev-list", "--count", "HEAD"], cwd)).toBe("2");
    expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("second\n");
  });
  it("falls back to a cold checkout for an absent cache directory", () => {
    const fixture = setup();
    expect(fixture.initialize({}, `${fixture.source}-missing-cache`).status).toBe(0);
    expect(fixture.git(["rev-parse", "HEAD"], join(fixture.data, "workspace"))).toBe(
      fixture.git(["rev-parse", "HEAD"], fixture.source),
    );
  });
  it("rejects unsafe fetch arguments without leaking command output", () => {
    const fixture = setup();
    const result = fixture.initialize({ REVISION: "--upload-pack=bad" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid revision");
  });
});
