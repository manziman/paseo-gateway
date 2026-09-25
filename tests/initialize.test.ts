import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    const script = `import { initialize } from ${JSON.stringify(pathToFileURL(resolve("docker/initialize.mjs")).href)}; await initialize(${JSON.stringify(data)}, ${JSON.stringify(referencePath)}, ${JSON.stringify(join(root, "pod-tmp", "checkout-budget.json"))});`;
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
  return { root, data, source, initialize, git, first };
}
describe("workspace checkout initialization", () => {
  it("does not overwrite a preexisting checkout-budget temp-file symlink", () => {
    const fixture = setup();
    const parent = join(fixture.root, "pod-tmp");
    mkdirSync(parent, { mode: 0o700 });
    const victim = join(fixture.root, "victim.txt");
    writeFileSync(victim, "sentinel");
    symlinkSync(victim, join(parent, "checkout-budget.json.tmp"));
    expect(fixture.initialize().status).toBe(0);
    expect(readFileSync(victim, "utf8")).toBe("sentinel");
  });
  it("rejects a symlinked checkout-budget receipt before any Git fetch", () => {
    const fixture = setup();
    const parent = join(fixture.root, "pod-tmp");
    mkdirSync(parent, { mode: 0o700 });
    const startedAt = Date.now() - 1000;
    const victim = join(fixture.root, "other-receipt.json");
    writeFileSync(
      victim,
      JSON.stringify({
        version: 1,
        startedAt,
        deadline: startedAt + 150000,
        attempts: 0,
        nextAttemptAt: 0,
      }),
      { mode: 0o600 },
    );
    symlinkSync(victim, join(parent, "checkout-budget.json"));
    const result = fixture.initialize();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CheckoutInitializationFailed");
    expect(existsSync(join(fixture.data, "checkout-ready"))).toBe(false);
    expect(existsSync(join(fixture.data, "workspace/.git"))).toBe(false);
    expect(readFileSync(victim, "utf8")).toContain('"attempts":0');
  });
  it("rejects a readable checkout-budget receipt before any Git fetch", () => {
    const fixture = setup();
    const parent = join(fixture.root, "pod-tmp");
    mkdirSync(parent, { mode: 0o700 });
    const startedAt = Date.now() - 1000;
    writeFileSync(
      join(parent, "checkout-budget.json"),
      JSON.stringify({
        version: 1,
        startedAt,
        deadline: startedAt + 150000,
        attempts: 0,
        nextAttemptAt: 0,
      }),
      { mode: 0o644 },
    );
    const result = fixture.initialize();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CheckoutInitializationFailed");
    expect(existsSync(join(fixture.data, "checkout-ready"))).toBe(false);
    expect(existsSync(join(fixture.data, "workspace/.git"))).toBe(false);
  });
  it("rejects a checkout-budget parent accessible by another user", () => {
    const fixture = setup();
    const parent = join(fixture.root, "pod-tmp");
    mkdirSync(parent);
    chmodSync(parent, 0o755);
    const result = fixture.initialize();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CheckoutInitializationFailed");
    expect(existsSync(join(fixture.data, "checkout-ready"))).toBe(false);
    expect(existsSync(join(fixture.data, "workspace/.git"))).toBe(false);
  });
  it("creates a branch with bounded history and preserves dirty work on restart", () => {
    const fixture = setup();
    expect(fixture.initialize({ BRANCH: "feature/test" }).status).toBe(0);
    const cwd = join(fixture.data, "workspace");
    expect(fixture.git(["branch", "--show-current"], cwd)).toBe("feature/test");
    expect(fixture.git(["rev-list", "--count", "HEAD"], cwd)).toBe("1");
    writeFileSync(join(cwd, "file.txt"), "local work\n");
    writeFileSync(join(fixture.root, "pod-tmp", "checkout-budget.json"), "corrupt old budget");
    expect(fixture.initialize({ REVISION: "missing" }).status).toBe(0);
    expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("local work\n");
  });
  it("does not retry a permanent fetch failure when kubelet reinvokes the same Pod initializer", () => {
    const fixture = setup();
    const bin = join(fixture.root, "bin");
    mkdirSync(bin);
    const count = join(fixture.root, "fetch-count");
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(bin, "git"),
      '#!/bin/sh\nif [ "$1" = "fetch" ]; then\n printf "x\\n" >> "$FETCH_COUNT"\n echo "fatal: Authentication failed" >&2\n exit 128\nfi\nexec "$REAL_GIT" "$@"\n',
      { mode: 0o755 },
    );
    const env = { PATH: `${bin}:${process.env.PATH}`, FETCH_COUNT: count, REAL_GIT: realGit };
    expect(fixture.initialize(env).status).not.toBe(0);
    expect(fixture.initialize(env).status).not.toBe(0);
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
  });
  it("limits transient fetches to three across repeated initializer processes", () => {
    const fixture = setup();
    const bin = join(fixture.root, "bin");
    mkdirSync(bin);
    const count = join(fixture.root, "fetch-count");
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(bin, "git"),
      '#!/bin/sh\nif [ "$1" = "fetch" ]; then\n printf "x\\n" >> "$FETCH_COUNT"\n echo "fatal: Could not resolve host: sensitive.invalid" >&2\n exit 128\nfi\nexec "$REAL_GIT" "$@"\n',
      { mode: 0o755 },
    );
    const env = { PATH: `${bin}:${process.env.PATH}`, FETCH_COUNT: count, REAL_GIT: realGit };
    const first = fixture.initialize(env);
    expect(first.status).not.toBe(0);
    const ledgerPath = join(fixture.root, "pod-tmp", "checkout-budget.json");
    const ledger = readFileSync(ledgerPath, "utf8");
    expect(JSON.parse(ledger)).toMatchObject({
      attempts: 3,
      failure: { code: "CheckoutDnsUnavailable" },
    });
    const second = fixture.initialize(env);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain("CheckoutDnsUnavailable");
    expect(second.stderr).not.toContain("sensitive.invalid");
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(3);
    expect(readFileSync(ledgerPath, "utf8")).toBe(ledger);
  });
  it("preserves a pre-fetch claim after a killed initializer and recovers within the original budget", () => {
    const fixture = setup();
    const bin = join(fixture.root, "bin");
    mkdirSync(bin);
    const count = join(fixture.root, "fetch-count");
    const killed = join(fixture.root, "killed-once");
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(bin, "git"),
      '#!/bin/sh\nif [ "$1" = "fetch" ]; then\n printf "x\\n" >> "$FETCH_COUNT"\n if [ ! -e "$KILLED_MARKER" ]; then\n : > "$KILLED_MARKER"\n kill -KILL "$PPID"\n exit 128\n fi\nfi\nexec "$REAL_GIT" "$@"\n',
      { mode: 0o755 },
    );
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      FETCH_COUNT: count,
      REAL_GIT: realGit,
      KILLED_MARKER: killed,
    };
    expect(fixture.initialize(env).signal).toBe("SIGKILL");
    const ledgerPath = join(fixture.root, "pod-tmp", "checkout-budget.json");
    const before = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(before.attempts).toBe(1);
    expect(fixture.initialize(env).status).toBe(0);
    const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(after).toMatchObject({ attempts: 2, deadline: before.deadline });
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(2);
  });
  it.each(["expired", "consumed", "corrupt", "backoff"])(
    "does not fetch from a %s persisted budget",
    (kind) => {
      const fixture = setup();
      const ledgerPath = join(fixture.root, "pod-tmp", "checkout-budget.json");
      mkdirSync(join(fixture.root, "pod-tmp"), { mode: 0o700 });
      const startedAt = Date.now() - (kind === "expired" ? 160000 : 1000);
      writeFileSync(
        ledgerPath,
        kind === "corrupt"
          ? "broken"
          : JSON.stringify({
              version: 1,
              startedAt,
              deadline: startedAt + 150000,
              attempts: kind === "consumed" ? 3 : 1,
              nextAttemptAt: kind === "backoff" ? startedAt + 160000 : 0,
            }),
        { mode: 0o600 },
      );
      const result = fixture.initialize();
      expect(result.status).not.toBe(0);
      expect(existsSync(join(fixture.data, "checkout-ready"))).toBe(false);
      expect(existsSync(join(fixture.data, "workspace/.git/FETCH_HEAD"))).toBe(false);
      expect(result.stderr).toContain(
        ["expired", "backoff"].includes(kind)
          ? "CheckoutFetchTimeout"
          : "CheckoutInitializationFailed",
      );
    },
  );
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
    expect(existsSync(join(fixture.data, "checkout-ready"))).toBe(false);
    expect(existsSync(join(fixture.data, "workspace/.git"))).toBe(true);
    // A new Pod (e.g. explicit suspend/resume) resets emptyDir, retaining its interrupted PVC.
    rmSync(join(fixture.root, "pod-tmp"), { recursive: true, force: true });
    expect(fixture.initialize().status).toBe(0);
    expect(existsSync(join(fixture.data, "checkout-ready"))).toBe(true);
    expect(readFileSync(join(fixture.data, "workspace/file.txt"), "utf8")).toBe("second\n");
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
  it("detaches a vanished reference cache and completes a bounded cold fetch", () => {
    const fixture = setup();
    const cache = `${fixture.source}-cache`;
    fixture.git(["clone", "--mirror", fixture.source, cache]);
    const bin = join(fixture.root, "bin");
    mkdirSync(bin);
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const marker = join(fixture.root, "dropped-cache");
    const count = join(fixture.root, "fetch-count");
    writeFileSync(
      join(bin, "git"),
      '#!/bin/sh\nif [ "$1" = "fetch" ]; then\n  printf "x\\n" >> "$FETCH_COUNT"\n  if [ ! -e "$FETCH_MARKER" ]; then\n    : > "$FETCH_MARKER"\n    rm -rf "$CACHE_OBJECTS"\n    echo "error: object directory /missing does not exist; check .git/objects/info/alternates" >&2\n    exit 128\n  fi\nfi\nexec "$REAL_GIT" "$@"\n',
      { mode: 0o755 },
    );
    const result = fixture.initialize(
      {
        PATH: `${bin}:${process.env.PATH}`,
        REAL_GIT: realGit,
        CACHE_OBJECTS: join(cache, "objects"),
        FETCH_MARKER: marker,
        FETCH_COUNT: count,
      },
      cache,
    );
    expect(result.status).toBe(0);
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(2);
    expect(existsSync(join(fixture.data, "workspace/.git/objects/info/alternates"))).toBe(false);
    expect(existsSync(join(fixture.data, "checkout-ready"))).toBe(true);
  });
  it("rejects unsafe fetch arguments without leaking command output", () => {
    const fixture = setup();
    const result = fixture.initialize({ REVISION: "--upload-pack=bad" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CheckoutConfigurationInvalid");
    expect(result.stderr).not.toContain("--upload-pack=bad");
  });
});
