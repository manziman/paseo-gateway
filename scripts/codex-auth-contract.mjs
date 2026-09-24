import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// No host credential mounts or network. Regenerate this contract from the exact
// image under qualification; the broker's legacy native export must remain pinned.
const selectedImage = process.argv[2];
if (!selectedImage) throw new Error("Usage: node scripts/codex-auth-contract.mjs WORKSPACE_IMAGE");
try {
  const output = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,mode=1777,size=67108864",
      "--entrypoint",
      "sh",
      selectedImage,
      "-c",
      "test -s /etc/ssl/certs/ca-certificates.crt || exit 1; codex --version; codex app-server generate-ts --experimental --out /tmp/codex-contract >/dev/null; cat /tmp/codex-contract/GetAuthStatusParams.ts /tmp/codex-contract/GetAuthStatusResponse.ts /tmp/codex-contract/v2/LoginAccountParams.ts /tmp/codex-contract/v2/ChatgptAuthTokensRefreshResponse.ts",
    ],
    { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.match(output, /codex-cli 0\.156\.1\b/);
  for (const field of [
    "includeToken: boolean",
    "refreshToken: boolean",
    "authToken: string",
    '"type": "chatgptAuthTokens"',
    "chatgptAccountId: string",
    "accessToken: string",
  ])
    assert.ok(output.includes(field));
  console.log(
    JSON.stringify({
      check: "pinned-native-codex-auth-contract",
      status: "passed",
      version: "0.156.1",
      credentialsUsed: false,
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      check: "pinned-native-codex-auth-contract",
      status: "failed",
      reason: "RuntimeOrProtocolChangedDetailsRedacted",
    }),
  );
  process.exitCode = 1;
}
