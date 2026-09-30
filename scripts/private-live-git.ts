/** Git commands used only for disposable private acceptance markers. */
export function acceptanceGitCommands(file: string, message: string, branch: string) {
  if (!/^\.paseo-gateway-(?:acceptance|scheduled)-[a-f0-9]{8}\.txt$/.test(file))
    throw new Error("Acceptance marker filename required");
  if (!/^paseo-gateway-acceptance\/[a-f0-9]{8}(?:-scheduled)?$/.test(branch))
    throw new Error("Acceptance branch required");
  return {
    add: ["git", "add", "--force", "--", file],
    commit: [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--only",
      "-m",
      message,
      "--",
      file,
    ],
    push: ["git", "-c", "core.hooksPath=/dev/null", "push", "origin", `HEAD:refs/heads/${branch}`],
  };
}

/** Render an argv for the scheduled worker's Bash prompt. */
export function shellCommand(argv: readonly string[]): string {
  return argv
    .map((arg) => (/^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
    .join(" ");
}

/** Keep the complete worker task as one CLI argument, including its quoted Git commands. */
export function scheduledWorkerCommand(
  projectId: string,
  branch: string,
  suffix: string,
  workerTask: string,
): string {
  return shellCommand([
    "/opt/paseo/bin/paseo",
    "run",
    "--provider",
    "claude",
    "--mode",
    "bypassPermissions",
    "--background",
    "--json",
    "--label",
    `acceptance=scheduled-${suffix}`,
    "--new-workspace",
    "worktree",
    "--cwd",
    `/projects/${projectId}`,
    "--new-branch",
    branch,
    "--base",
    "origin/main",
    workerTask,
  ]);
}
