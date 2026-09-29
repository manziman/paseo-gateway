import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

const MAX_INPUT = 8 * 1024 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024 + 65536;
const MAX_FILES_PER_UID = 16;
const uidPattern = /^[a-f0-9]{8}-[a-f0-9-]{27,63}$/i;

function directory(env) {
  return resolve(env.PASEO_RETAINED_HISTORY_ROOT ?? resolve(env.HOME, ".paseo/gateway-history"));
}

async function assertDirectory(path, create) {
  if (!isAbsolute(path)) throw new Error("Retained history directory must be absolute");
  let current = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Retained history path contains an unsafe parent");
  }
  const stat = await lstat(path);
  if (stat.uid !== process.getuid() || (stat.mode & 0o007) !== 0)
    throw new Error("Retained history directory is not private");
  if (create && (stat.mode & 0o077) !== 0) await chmod(path, 0o700);
}

async function inputBytes() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > MAX_INPUT) throw new Error("Retained history exceeds storage budget");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function writeSnapshot(root, uid, bytes) {
  if (!uidPattern.test(uid) || bytes.byteLength > MAX_INPUT)
    throw new Error("Invalid retained history identity or size");
  await assertDirectory(root, true);
  const existing = (await readdir(root)).filter((name) => snapshotParts(uid, name));
  if (existing.length >= MAX_FILES_PER_UID) throw new Error("Retained history file budget reached");
  const value = JSON.parse(bytes.toString("utf8"));
  if (
    value.version !== 1 ||
    value.workspaceUid !== uid ||
    !Number.isSafeInteger(value.workspaceGeneration) ||
    value.workspaceGeneration < 1 ||
    !Number.isFinite(Date.parse(value.capturedAt)) ||
    !value.agents ||
    Array.isArray(value.agents)
  )
    throw new Error("Invalid retained history snapshot");
  const generation = value.workspaceGeneration;
  const capturedMs = Date.parse(value.capturedAt);
  const fileName = `${uid}-${generation}-${String(capturedMs).padStart(13, "0")}-${randomUUID()}.json`;
  const target = resolve(root, fileName);
  const temp = resolve(root, `.${uid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  const parent = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  return fileName;
}

function snapshotParts(uid, fileName) {
  const match = new RegExp(`^${uid}-(\\d+)-(\\d{13})-[a-f0-9-]+\\.json$`).exec(fileName);
  return match ? { generation: Number(match[1]), capturedMs: Number(match[2]) } : null;
}

/** Never remove the receipt file or a generation/capture newer than it. */
export async function pruneSnapshots(root, uid, committedFileName) {
  if (!uidPattern.test(uid)) throw new Error("Invalid retained history identity");
  const committed = committedFileName ? snapshotParts(uid, committedFileName) : null;
  if (committedFileName && !committed) throw new Error("Invalid retained history receipt filename");
  try {
    await assertDirectory(root, false);
  } catch (error) {
    if (!committedFileName && error.code === "ENOENT") return;
    throw error;
  }
  for (const name of await readdir(root)) {
    if (name === committedFileName) continue;
    const parts = snapshotParts(uid, name);
    if (!parts) continue;
    const path = resolve(root, name);
    const stat = await lstat(path);
    const obsolete =
      committed &&
      (parts.generation < committed.generation ||
        (parts.generation === committed.generation && parts.capturedMs <= committed.capturedMs));
    // Age cannot prove a finalized file is unpublished. The first receipt may
    // still be in flight, or this caller may hold an earlier receipt.
    if (obsolete && (stat.isFile() || stat.isSymbolicLink())) await rm(path);
  }
  // Temp files cannot be active after the bounded controller capture and API
  // windows. A generous age avoids deleting a still-publishing snapshot.
  for (const name of await readdir(root)) {
    if (!new RegExp(`^\\.${uid}\\.[a-f0-9-]+\\.tmp$`).test(name)) continue;
    const path = resolve(root, name);
    const stat = await lstat(path);
    if (Date.now() - stat.mtimeMs > 10 * 60_000 && (stat.isFile() || stat.isSymbolicLink()))
      await rm(path);
  }
}

export async function readAgent(root, uid, agentId, generation, fileName) {
  if (
    !uidPattern.test(uid) ||
    agentId.length > 256 ||
    !agentId ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    throw new Error("Invalid retained history identity");
  await assertDirectory(root, false);
  if (!new RegExp(`^${uid}-${generation}-\\d{13}-[a-f0-9-]+\\.json$`).test(fileName))
    throw new Error("Invalid retained history receipt filename");
  let handle;
  try {
    handle = await open(resolve(root, fileName), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return { found: false };
    throw error;
  }
  let value;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > MAX_INPUT)
      throw new Error("Invalid retained history file");
    value = JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
  if (
    value.version !== 1 ||
    value.workspaceUid !== uid ||
    value.workspaceGeneration !== generation ||
    typeof value.agents !== "object"
  )
    throw new Error("Retained history UID mismatch");
  const history = Object.hasOwn(value.agents, agentId) ? value.agents[agentId] : undefined;
  const answer = history
    ? {
        found: true,
        history,
        capturedAt: value.capturedAt,
        workspaceGeneration: value.workspaceGeneration,
      }
    : { found: false };
  if (Buffer.byteLength(JSON.stringify(answer)) > MAX_OUTPUT)
    throw new Error("Retained history response exceeds budget");
  return answer;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const [mode, uid, agentId, generation, fileName] = process.argv.slice(2);
    if (mode === "write") {
      const committed = await writeSnapshot(directory(process.env), uid, await inputBytes());
      process.stdout.write(`${committed}\n`);
    } else if (mode === "read") {
      process.stdout.write(
        `${JSON.stringify(await readAgent(directory(process.env), uid, agentId, Number(generation), fileName))}\n`,
      );
    } else if (mode === "prune") {
      await pruneSnapshots(directory(process.env), uid, agentId);
    } else throw new Error("Invalid retained history operation");
  } catch {
    // Never print transcript bytes, filesystem paths, or provider details to logs.
    process.stderr.write("Retained history operation failed\n");
    process.exitCode = 1;
  }
}
