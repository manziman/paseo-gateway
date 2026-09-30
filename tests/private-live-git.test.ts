import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
  acceptanceGitCommands,
  scheduledWorkerCommand,
  shellCommand,
} from "../scripts/private-live-git.js";

function bashArguments(command: string): string[] {
  const result = spawnSync("bash", ["-c", `set -- ${command}; printf '%s\\0' "$@"`]);
  assert.equal(result.status, 0);
  return result.stdout.toString("utf8").split("\0").slice(0, -1);
}

describe("private acceptance Git commands", () => {
  it("keeps nested scheduled Git commands inside one exact worker prompt argument", () => {
    const branch = "paseo-gateway-acceptance/033d7a68-scheduled";
    const commands = acceptanceGitCommands(
      ".paseo-gateway-scheduled-033d7a68.txt",
      "gateway acceptance 033d7a68",
      branch,
    );
    const task = `Run ${shellCommand(commands.add)}; ${shellCommand(commands.commit)}; ${shellCommand(commands.push)}. Don't retry.`;
    const outer = bashArguments(
      scheduledWorkerCommand("private-project", branch, "033d7a68", task),
    );
    assert.equal(outer[0], "/opt/paseo/bin/paseo");
    assert.equal(outer[outer.indexOf("--new-branch") + 1], branch);
    assert.equal(outer[outer.indexOf("--label") + 1], "acceptance=scheduled-033d7a68");
    assert.equal(outer[outer.length - 1], task);
    assert.deepEqual(bashArguments(shellCommand(commands.add)), commands.add);
    assert.deepEqual(bashArguments(shellCommand(commands.commit)), commands.commit);
    assert.deepEqual(bashArguments(shellCommand(commands.push)), commands.push);
  });

  it("commits only an ignored marker and bypasses local hooks for the disposable push", () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-private-git-"));
    try {
      const remote = join(directory, "remote.git");
      const checkout = join(directory, "checkout");
      mkdirSync(checkout);
      const run = (argv: readonly string[], cwd = checkout) => {
        const [program, ...arguments_] = argv;
        if (!program) throw new Error("Git command required");
        return execFileSync(program, arguments_, { cwd, encoding: "utf8", stdio: "pipe" });
      };
      run(["git", "init", "--bare", "-q", remote], directory);
      run(["git", "init", "-q", "-b", "main"]);
      run(["git", "config", "user.email", "acceptance@example.invalid"]);
      run(["git", "config", "user.name", "Acceptance"]);
      run(["git", "config", "commit.gpgsign", "false"]);
      writeFileSync(join(checkout, ".gitignore"), ".paseo-gateway-acceptance-*.txt\n");
      writeFileSync(join(checkout, "tracked.txt"), "original\n");
      run(["git", "add", ".gitignore", "tracked.txt"]);
      run(["git", "commit", "-qm", "initial"]);
      run(["git", "remote", "add", "origin", remote]);
      const hooks = join(checkout, ".githooks");
      mkdirSync(hooks);
      writeFileSync(
        join(hooks, "pre-commit"),
        "#!/bin/sh\necho pre-commit-blocked >&2\nexit 41\n",
        {
          mode: 0o755,
        },
      );
      writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\necho pre-push-blocked >&2\nexit 42\n", {
        mode: 0o755,
      });
      run(["git", "config", "core.hooksPath", hooks]);
      const blockedCommit = spawnSync("git", ["commit", "--allow-empty", "-m", "hook control"], {
        cwd: checkout,
        encoding: "utf8",
      });
      assert.notEqual(blockedCommit.status, 0);
      assert.match(blockedCommit.stderr, /pre-commit-blocked/);
      const blockedPush = spawnSync("git", ["push", "origin", "HEAD:refs/heads/hook-control"], {
        cwd: checkout,
        encoding: "utf8",
      });
      assert.notEqual(blockedPush.status, 0);
      assert.match(blockedPush.stderr, /pre-push-blocked/);

      const marker = ".paseo-gateway-acceptance-033d7a68.txt";
      writeFileSync(join(checkout, marker), "marker\n");
      writeFileSync(join(checkout, "tracked.txt"), "unrelated change\n");
      writeFileSync(join(checkout, "unrelated.txt"), "unrelated untracked\n");
      const commands = acceptanceGitCommands(
        marker,
        "test: acceptance",
        "paseo-gateway-acceptance/033d7a68",
      );
      run(commands.add);
      assert.equal(run(["git", "diff", "--cached", "--name-only"]).trim(), marker);
      run(commands.commit);
      assert.equal(run(["git", "show", "--pretty=", "--name-only", "HEAD"]).trim(), marker);
      assert.equal(run(["git", "diff", "--cached", "--name-only"]).trim(), "");
      assert.equal(
        run(["git", "status", "--short"]).trimEnd(),
        " M tracked.txt\n?? .githooks/\n?? unrelated.txt",
      );
      run(commands.push);
      assert.equal(
        run([
          "git",
          "--git-dir",
          remote,
          "show",
          "--pretty=",
          "--name-only",
          "refs/heads/paseo-gateway-acceptance/033d7a68",
        ]).trim(),
        marker,
      );
      assert.match(shellCommand(commands.add), /git add --force --/);
      assert.match(shellCommand(commands.commit), /core\.hooksPath=\/dev\/null/);
      assert.match(shellCommand(commands.push), /core\.hooksPath=\/dev\/null/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
