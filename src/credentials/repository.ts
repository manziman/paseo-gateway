export const REPOSITORY_PATTERN =
  "^(https://[^/@:?#\\s]+(:[0-9]+)?/[^?#\\s]+|ssh://git@[^/@:?#\\s]+(:[0-9]+)?/[^?#\\s]+|git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+)$";
/** Restrict repository transports and reject URL credentials before serializing a project. */
export function repositoryLocation(value: string): {
  transport: "https" | "ssh";
  host: string;
  hostname: string;
  path: string;
} {
  const scp = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+)$/.exec(value);
  if (scp?.[1] && scp[2]) return { transport: "ssh", host: scp[1], hostname: scp[1], path: scp[2] };
  const url = new URL(value);
  if (url.search || url.hash || !url.hostname || !url.pathname.slice(1))
    throw new Error("Invalid repository location");
  if (url.protocol === "https:" && !url.username && !url.password)
    return {
      transport: "https",
      host: url.host,
      hostname: url.hostname,
      path: url.pathname.slice(1),
    };
  if (url.protocol === "ssh:" && url.username === "git" && !url.password)
    return {
      transport: "ssh",
      host: url.host,
      hostname: url.hostname,
      path: url.pathname.slice(1),
    };
  throw new Error("Use HTTPS without credentials or SSH with the git user");
}
export function validRepository(value: string): boolean {
  try {
    if (!new RegExp(REPOSITORY_PATTERN).test(value)) return false;
    repositoryLocation(value);
    return !/[\s]/.test(value);
  } catch {
    return false;
  }
}
