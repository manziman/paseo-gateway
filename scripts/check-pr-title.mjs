const title = process.env.PR_TITLE;

const convention =
  /^(feat|fix|perf|docs|refactor|test|build|ci|chore|style|revert)(\([a-z0-9][a-z0-9./_-]*\))?(!)?: [^\s](?:.*\S)?$/;

if (!title || title.includes("\n") || title.includes("\r") || !convention.test(title)) {
  console.error("PR title must be a Conventional Commit subject, for example:");
  console.error("  feat: add workspace retention");
  console.error("  fix(chart): preserve identity Secret");
  console.error("  feat!: remove the legacy protocol");
  process.exitCode = 1;
} else {
  console.log("Valid Conventional Commit PR title.");
}
