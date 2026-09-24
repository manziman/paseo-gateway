import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { installationTokenStatusScript } from "../scripts/github-app-probe.js";

it("refuses revocation if the projected token changed and prints no credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "app-probe-"));
  const file = join(directory, "token");
  const token = "synthetic-acceptance-token";
  writeFileSync(file, token);
  const fakeRequest = "globalThis.fetch=async()=>({status:204});\n";
  try {
    const wrong = spawnSync(
      process.execPath,
      [
        "-e",
        fakeRequest + installationTokenStatusScript,
        "DELETE",
        "installation/token",
        "different-token-digest",
        file,
      ],
      { encoding: "utf8" },
    );
    expect(wrong.status).toBe(2);
    expect(wrong.stdout).toBe("");
    expect(wrong.stderr).toBe("");
    const matching = spawnSync(
      process.execPath,
      [
        "-e",
        fakeRequest + installationTokenStatusScript,
        "DELETE",
        "installation/token",
        createHash("sha256").update(token).digest("hex"),
        file,
      ],
      { encoding: "utf8" },
    );
    expect(matching.status).toBe(0);
    expect(matching.stdout).toBe("204");
    expect(matching.stderr).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
