import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../docker/inspect-refs.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "paseo-ref-https-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function fixture() {
  const seed = join(root, "seed");
  const remote = join(root, "remote.git");
  git(root, "init", "-b", "main", seed);
  git(seed, "config", "user.name", "Fixture");
  git(seed, "config", "user.email", "fixture@example.test");
  git(seed, "config", "commit.gpgsign", "false");
  git(seed, "commit", "--allow-empty", "-m", "base");
  git(seed, "switch", "-c", "feature/alpha");
  git(seed, "commit", "--allow-empty", "-m", "alpha");
  git(seed, "branch", "origin/feature");
  git(root, "clone", "--bare", seed, remote);
  const key = join(root, "key.pem");
  const cert = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? "/", "https://localhost");
      const child = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.searchParams.toString(),
          REQUEST_METHOD: request.method ?? "GET",
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.length),
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      child.stdin.end(body);
      const output: Buffer[] = [];
      for await (const chunk of child.stdout) output.push(Buffer.from(chunk));
      const raw = Buffer.concat(output);
      const separator = raw.indexOf("\r\n\r\n");
      if (separator < 0) {
        response.writeHead(502);
        response.end();
        return;
      }
      const headers = raw.subarray(0, separator).toString("utf8").split("\r\n");
      let status = 200;
      const responseHeaders: Record<string, string> = {};
      for (const line of headers) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === "status") status = Number(value.slice(0, 3));
        else responseHeaders[name] = value;
      }
      response.writeHead(status, responseHeaders);
      response.end(raw.subarray(separator + 4));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test HTTPS listener unavailable");
  return { server, repository: `https://127.0.0.1:${address.port}/remote.git` };
}

async function run(
  repository: string,
  mode: "suggest" | "validate",
  extra: Record<string, string>,
) {
  const resultFile = join(root, `result-${mode}-${Math.random()}.json`);
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      GIT_SSL_NO_VERIFY: "1",
      REPOSITORY: repository,
      REF_MODE: mode,
      PASEO_REF_RESULT_FILE: resultFile,
      ...extra,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { exitCode, result: JSON.parse(readFileSync(resultFile, "utf8")) };
}

describe("disposable inspector against real Git smart HTTPS", () => {
  it("suggests bounded remote heads and validates names without creating refs", async () => {
    const { server, repository } = await fixture();
    try {
      const suggestions = await run(repository, "suggest", { REF_QUERY: "feat", REF_LIMIT: "20" });
      expect(suggestions).toEqual({
        exitCode: 0,
        result: { version: 1, refs: ["feature/alpha", "origin/feature"] },
      });
      const qualified = await run(repository, "suggest", {
        REF_QUERY: "origin/feature",
        REF_LIMIT: "20",
      });
      expect(qualified.result).toEqual({
        version: 1,
        refs: ["feature/alpha", "origin/feature"],
      });
      const existing = await run(repository, "validate", { REF_NAME: "feature/alpha" });
      expect(existing.result).toEqual({ version: 1, valid: true, exists: true });
      const qualifiedExisting = await run(repository, "validate", {
        REF_NAME: "refs/remotes/origin/feature/alpha",
      });
      expect(qualifiedExisting.result).toEqual({ version: 1, valid: true, exists: true });
      const literalHead = await run(repository, "validate", {
        REF_NAME: "refs/heads/origin/feature",
      });
      expect(literalHead.result).toEqual({ version: 1, valid: true, exists: true });
      const foreignRemote = await run(repository, "validate", {
        REF_NAME: "refs/remotes/upstream/feature",
      });
      expect(foreignRemote.result).toEqual({ version: 1, valid: false, exists: false });
      const fresh = await run(repository, "validate", { REF_NAME: "feature/new" });
      expect(fresh.result).toEqual({ version: 1, valid: true, exists: false });
      const invalid = await run(repository, "validate", { REF_NAME: "bad..branch" });
      expect(invalid.result).toEqual({ version: 1, valid: false, exists: false });
      expect(
        git(
          root,
          "--git-dir",
          join(root, "remote.git"),
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/feature/new",
        ),
      ).toBe("");
    } finally {
      server.close();
    }
  }, 30_000);

  it("kills a hanging Git transport descendant and settles before the Pod deadline", async () => {
    const fakeBin = join(root, "fake-bin");
    const helper = join(fakeBin, "git");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(fakeBin);
    writeFileSync(helper, "#!/bin/sh\nsleep 30 &\nwait\n", { mode: 0o700 });
    chmodSync(helper, 0o700);
    const started = Date.now();
    const response = await run("https://example.test/owner/repo.git", "suggest", {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      REF_QUERY: "feature",
      REF_LIMIT: "20",
      PASEO_REF_TEST_MAX_RUN_MS: "150",
    });
    expect(response.exitCode).toBe(1);
    expect(response.result).toEqual({ version: 1, error: "git-query-failed" });
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 5_000);
});
