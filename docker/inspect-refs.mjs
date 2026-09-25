import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const MAX_REMOTE_BYTES = 1_000_000;
const MAX_REFS = 10_000;
const MAX_RESULT_BYTES = 3_500;
const TEST_RUN_MS = Number(process.env.PASEO_REF_TEST_MAX_RUN_MS);
const MAX_RUN_MS =
  Number.isSafeInteger(TEST_RUN_MS) && TEST_RUN_MS > 0 ? Math.min(TEST_RUN_MS, 35_000) : 35_000;
// The gateway Pod never sets this override; local contract tests use a private file.
const TERMINATION_LOG = process.env.PASEO_REF_RESULT_FILE ?? "/dev/termination-log";

function validRepository(value) {
  if (!value || /\s/.test(value)) return false;
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      !url.search &&
      !url.hash &&
      !!url.hostname &&
      !!url.pathname.slice(1) &&
      ((url.protocol === "https:" && !url.username && !url.password) ||
        (url.protocol === "ssh:" && url.username === "git" && !url.password))
    );
  } catch {
    return false;
  }
}

async function git(args, maxBytes = MAX_REMOTE_BYTES) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      detached: true,
    });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      if (error) reject(error);
      else resolve(output);
    };
    const stop = () => {
      if (settled) return;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(new Error("git-query-failed"));
    };
    const timer = setTimeout(stop, MAX_RUN_MS);
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) stop();
      else chunks.push(chunk);
    });
    child.on("error", () => finish(new Error("git-unavailable")));
    child.on("close", (code) => {
      if (code !== 0) finish(new Error("git-query-failed"));
      else finish(undefined, Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function parseRefs(output) {
  const refs = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/heads\/([^\r\n]+)$/.exec(line);
    if (!match || match[2].length > 200) throw new Error("invalid-ref-list");
    refs.push(match[2]);
    if (refs.length > MAX_REFS) throw new Error("ref-list-too-large");
  }
  return refs;
}

function normalizeName(value) {
  let name = value.trim();
  if (name.startsWith("refs/remotes/origin/")) name = name.slice("refs/remotes/origin/".length);
  else if (name.startsWith("refs/remotes/")) return null;
  else if (name.startsWith("refs/heads/")) name = name.slice("refs/heads/".length);
  else if (name.startsWith("origin/")) name = name.slice("origin/".length);
  return name && name !== "HEAD" && name !== "origin" ? name : null;
}

async function inspect() {
  await mkdir(process.env.HOME ?? "/tmp/home", { recursive: true });
  const repository = process.env.REPOSITORY;
  if (!validRepository(repository)) throw new Error("invalid-repository");
  const mode = process.env.REF_MODE;
  if (mode !== "suggest" && mode !== "validate") throw new Error("invalid-mode");
  if (mode === "validate") {
    const name = normalizeName(process.env.REF_NAME ?? "");
    if (!name || name.length > 200) return { version: 1, valid: false, exists: false };
    try {
      await git(["check-ref-format", "--branch", name], 512);
    } catch {
      return { version: 1, valid: false, exists: false };
    }
    const refs = parseRefs(
      await git(["ls-remote", "--heads", "--refs", repository, `refs/heads/${name}`]),
    );
    return { version: 1, valid: true, exists: refs.includes(name) };
  }
  const rawQuery = (process.env.REF_QUERY ?? "").trim().toLowerCase();
  const query = normalizeName(rawQuery) ?? rawQuery;
  const limit = Number(process.env.REF_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || query.length > 200)
    throw new Error("invalid-query");
  const refs = parseRefs(await git(["ls-remote", "--heads", "--refs", repository]));
  const names = [...new Set(refs)]
    .filter((name) => name.toLowerCase().includes(query))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, Math.min(limit, 20));
  return { version: 1, refs: names };
}

let result;
try {
  result = await inspect();
} catch (error) {
  result = { version: 1, error: error instanceof Error ? error.message : "ref-query-failed" };
}
const serialized = JSON.stringify(result);
await writeFile(
  TERMINATION_LOG,
  Buffer.byteLength(serialized) <= MAX_RESULT_BYTES
    ? serialized
    : JSON.stringify({ version: 1, error: "result-too-large" }),
  { mode: 0o600 },
);
if (result.error) process.exitCode = 1;
