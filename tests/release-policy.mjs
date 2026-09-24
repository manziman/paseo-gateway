import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import config, { analyzer } from "../release.config.mjs";

const logger = { log() {}, error() {}, success() {} };
for (const [message, expected] of [
  ["docs: clarify installation", null],
  ["test: cover reconnect", null],
  ["fix: recover connections", "patch"],
  ["feat: add workspaces", "minor"],
  ["feat!: replace API", "major"],
  ["fix: change identity\n\nBREAKING CHANGE: use retained identity", "major"],
  ["build(deps): update shipped dependencies", "patch"],
  ["build(runtime): update node image", "patch"],
  ["fix(chart): preserve workspace storage", "patch"],
  ["chore: tidy scripts", null],
]) {
  test(`official commit analyzer: ${message.split("\n")[0]}`, async () => {
    assert.equal(
      await analyzeCommits(analyzer, {
        cwd: process.cwd(),
        commits: [{ hash: "a".repeat(40), message }],
        logger,
      }),
      expected,
    );
  });
}
function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function release(options, cwd) {
  const resultPath = join(cwd, "result.json");
  const script = `import semanticRelease from ${JSON.stringify(resolve("node_modules/semantic-release/index.js"))}; import {writeFileSync} from 'node:fs'; const result=await semanticRelease(${JSON.stringify(options)}, {cwd:${JSON.stringify(cwd)}}); writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(result));`;
  const env = { ...process.env };
  for (const key of ["GITHUB_ACTIONS", "GITHUB_TOKEN", "GH_TOKEN", "NODE_TEST_CONTEXT"])
    delete env[key];
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  return JSON.parse(readFileSync(resultPath, "utf8"));
}
async function fixture(
  t,
  { message, branch = "main", previous, expected, publishFirst = false, failFirst = false },
) {
  const directory = mkdtempSync(join(tmpdir(), "paseo-release-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, "remote.git");
  const cwd = join(directory, "repo");
  git(directory, "init", "--bare", "--initial-branch=main", remote);
  git(directory, "clone", remote, cwd);
  git(cwd, "config", "user.name", "Release fixture");
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "config", "tag.gpgsign", "false");
  git(cwd, "config", "user.email", "fixture@example.invalid");
  git(cwd, "checkout", "-b", "main");
  git(cwd, "commit", "--allow-empty", "-m", "docs: baseline");
  if (previous) git(cwd, "tag", `v${previous}`);
  git(cwd, "push", "origin", "main", "--tags");
  if (branch !== "main") git(cwd, "checkout", "-b", branch);
  const options = {
    ...config,
    repositoryUrl: `file://${remote}`,
    ci: false,
    dryRun: true,
    plugins: [
      [resolve("node_modules/@semantic-release/commit-analyzer/index.js"), analyzer],
      [
        resolve("node_modules/@semantic-release/release-notes-generator/index.js"),
        {
          preset: "conventionalcommits",
          host: "https://github.com",
          linkCompare: false,
          linkReferences: false,
        },
      ],
    ],
  };
  // Use a real local first publication to exercise semantic-release's own prerelease Git notes.
  if (publishFirst) {
    git(cwd, "commit", "--allow-empty", "-m", "feat: first candidate");
    git(cwd, "push", "origin", branch);
    if (failFirst) {
      const execConfig = config.plugins.find(([name]) => name === "@semantic-release/exec")[1];
      assert.ok(execConfig.publishCmd);
      assert.equal(execConfig.prepareCmd, undefined);
      assert.throws(() =>
        release(
          {
            ...options,
            dryRun: false,
            plugins: [
              ...options.plugins,
              [resolve("node_modules/@semantic-release/exec/index.js"), { publishCmd: "exit 1" }],
            ],
          },
          cwd,
        ),
      );
      assert.equal(git(cwd, "rev-parse", "v1.0.0-alpha.1"), git(cwd, "rev-parse", "HEAD"));
      assert.match(git(cwd, "ls-remote", "--tags", "origin"), /refs\/tags\/v1\.0\.0-alpha\.1/);
    } else {
      const first = release({ ...options, dryRun: false }, cwd);
      assert.equal(first.nextRelease.version, "1.0.0-alpha.1");
    }
  }
  git(cwd, "commit", "--allow-empty", "-m", message);
  git(cwd, "push", "origin", branch);
  const result = release(options, cwd);
  assert.equal(result ? result.nextRelease.version : false, expected);
  if (result) assert.equal(typeof result.nextRelease.notes, "string");
}
for (const scenario of [
  { message: "docs: no release", expected: false },
  { message: "feat: first candidate", branch: "alpha", expected: "1.0.0-alpha.1" },
  { message: "fix: stable patch fixture", previous: "1.2.3", expected: "1.2.4" },
  { message: "feat: stable minor fixture", previous: "1.2.3", expected: "1.3.0" },
  { message: "feat!: stable breaking fixture", previous: "1.2.3", expected: "2.0.0" },
  {
    message: "fix: second candidate",
    branch: "alpha",
    publishFirst: true,
    expected: "1.0.0-alpha.2",
  },
  {
    message: "fix: repair source after incomplete publication",
    branch: "alpha",
    publishFirst: true,
    failFirst: true,
    expected: "1.0.0-alpha.2",
  },
])
  test(`semantic-release Git rehearsal: ${scenario.expected}`, (t) => fixture(t, scenario));
