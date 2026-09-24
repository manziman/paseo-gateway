// Implements only `get`: tokens stay in Secret-backed environment variables, never on disk.
import { readFileSync } from "node:fs";
import { readGitToken } from "./token-file.mjs";

if (process.argv[2] === "get") {
  const input = readFileSync(0, "utf8");
  const fields = Object.fromEntries(
    input
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  let token;
  try {
    token = readGitToken();
  } catch {
    process.stderr.write("Git credentials unavailable\n");
    process.exit(1);
  }
  const username = process.env.PASEO_GIT_USERNAME || "x-access-token";
  if (
    fields.protocol === "https" &&
    fields.host === process.env.PASEO_GIT_HOST &&
    fields.path === process.env.PASEO_GIT_PATH &&
    token &&
    !/[\r\n]/.test(token + username) &&
    !(token + username).includes(String.fromCharCode(0))
  ) {
    process.stdout.write(`username=${username}\npassword=${token}\n\n`);
  }
}
