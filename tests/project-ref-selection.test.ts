import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkedOutBranchName,
  fetchRevisionForRef,
  normalizeProjectBranchName,
} from "../src/gateway/project-ref-selection.js";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("selected Project ref", () => {
  it("maps pinned Desktop tracking refs to fetchable origin heads", () => {
    expect(fetchRevisionForRef("refs/remotes/origin/feature/a")).toBe("refs/heads/feature/a");
    expect(fetchRevisionForRef("origin/main")).toBe("refs/heads/main");
    expect(fetchRevisionForRef("refs/heads/main")).toBe("refs/heads/main");
    expect(fetchRevisionForRef("refs/heads/origin/feature")).toBe("refs/heads/origin/feature");
    expect(fetchRevisionForRef("f".repeat(40))).toBe("f".repeat(40));
    expect(checkedOutBranchName("refs/remotes/origin/feature/a")).toBe("feature/a");
    expect(normalizeProjectBranchName("refs/remotes/origin/feature/a")).toBe("feature/a");
    expect(normalizeProjectBranchName("refs/heads/origin/feature")).toBe("origin/feature");
    expect(normalizeProjectBranchName("refs/remotes/upstream/feature")).toBeNull();
    expect(() => fetchRevisionForRef("refs/remotes/upstream/main")).toThrow("configured origin");
  });

  it("fetches the selected source commit and creates the requested isolated branch", () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-selected-ref-"));
    try {
      const seed = join(root, "seed");
      const remote = join(root, "remote.git");
      const isolated = join(root, "isolated");
      git(root, "init", "-b", "main", seed);
      git(seed, "config", "user.name", "Fixture");
      git(seed, "config", "user.email", "fixture@example.test");
      git(seed, "config", "commit.gpgsign", "false");
      git(seed, "commit", "--allow-empty", "-m", "base");
      const mainCommit = git(seed, "rev-parse", "HEAD");
      git(seed, "switch", "-c", "feature/source");
      git(seed, "commit", "--allow-empty", "-m", "feature");
      const selectedCommit = git(seed, "rev-parse", "HEAD");
      expect(selectedCommit).not.toBe(mainCommit);
      git(root, "clone", "--bare", seed, remote);
      git(root, "init", isolated);
      git(isolated, "remote", "add", "origin", remote);
      git(
        isolated,
        "fetch",
        "--no-recurse-submodules",
        "--",
        "origin",
        fetchRevisionForRef("refs/remotes/origin/feature/source"),
      );
      git(isolated, "checkout", "--detach", "FETCH_HEAD");
      git(isolated, "switch", "-c", "feature/new-work");
      expect(git(isolated, "rev-parse", "HEAD")).toBe(selectedCommit);
      expect(git(isolated, "branch", "--show-current")).toBe("feature/new-work");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
