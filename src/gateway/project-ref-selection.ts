/** Kubernetes checkout initializes a fresh Git repository and fetches from origin.
 * Picker refs name local tracking refs in the Desktop; Git transport must fetch
 * their authoritative remote heads instead of asking origin for a local ref.
 */
export function fetchRevisionForRef(ref: string): string {
  const remote = ref.startsWith("refs/remotes/origin/")
    ? ref.slice("refs/remotes/origin/".length)
    : ref.startsWith("origin/")
      ? ref.slice("origin/".length)
      : undefined;
  if (remote !== undefined) {
    if (!remote || remote === "HEAD") throw new Error("Selected remote branch is invalid");
    return `refs/heads/${remote}`;
  }
  if (ref.startsWith("refs/remotes/"))
    throw new Error("Only configured origin remote refs are supported");
  return ref;
}

export function checkedOutBranchName(ref: string): string {
  const normalized = fetchRevisionForRef(ref);
  if (normalized.startsWith("refs/heads/")) return normalized.slice("refs/heads/".length);
  return normalized;
}

/** Match the pinned daemon's branch validation naming on Project virtual paths. */
export function normalizeProjectBranchName(raw: string): string | null {
  let name = raw.trim();
  if (name.startsWith("refs/remotes/origin/")) name = name.slice("refs/remotes/origin/".length);
  else if (name.startsWith("refs/remotes/")) return null;
  else if (name.startsWith("refs/heads/")) name = name.slice("refs/heads/".length);
  else if (name.startsWith("origin/")) name = name.slice("origin/".length);
  return name && name !== "HEAD" && name !== "origin" ? name : null;
}
