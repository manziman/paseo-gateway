import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const cases = [
  ["feat: add workspace retention", true],
  ["fix(chart): preserve identity Secret", true],
  ["docs: explain installation", true],
  ["feat!: remove the legacy protocol", true],
  ["fix(api)!: reject expired tokens", true],
  ["fix(deps): bump upstream packages", true],
  ["Bump upstream packages", false],
  ["feat: ", false],
  ["Feat: add workspace retention", false],
  ["feat(scope):  leading space", false],
  ["feat: trailing space ", false],
  ["feat: valid\nrun unexpected command", false],
  ["feat(scope with space): invalid", false],
  ["feat: $(echo untrusted)", true],
];

for (const [title, valid] of cases) {
  test(JSON.stringify(title), () => {
    const result = spawnSync(
      process.execPath,
      [new URL("./check-pr-title.mjs", import.meta.url).pathname],
      {
        env: { ...process.env, PR_TITLE: title },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, valid ? 0 : 1, result.stderr);
  });
}
