// Repair only a tagged alpha version after semantic-release's GitHub publish step failed.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publish } from "@semantic-release/github";
import { generateNotes } from "@semantic-release/release-notes-generator";
import { github } from "../release.config.mjs";
import { prepare, run, validateInput } from "./release-artifacts.mjs";

export async function recover(
  version,
  {
    command = run,
    prepareArtifacts = prepare,
    publishRelease = publish,
    notesGenerator = generateNotes,
  } = {},
) {
  const revision = command("git", ["rev-parse", "HEAD"]);
  validateInput(version, revision);
  const tag = `v${version}`;
  if (command("git", ["rev-parse", `${tag}^{commit}`]) !== revision)
    throw new Error("Recovery requires checkout of the original tagged source");
  command("git", ["merge-base", "--is-ancestor", revision, "origin/alpha"]);
  const releases = JSON.parse(
    command("gh", ["api", "--paginate", "--slurp", "repos/manziman/paseo-gateway/releases"]),
  ).flat();
  const existing = releases.find((release) => release.tag_name === tag);
  if (existing && !existing.draft)
    throw new Error("This release is already public; do not overwrite it");
  await prepareArtifacts(version, revision);
  const previous = command("git", [
    "tag",
    "--merged",
    revision,
    "--sort=-version:refname",
    "--list",
    "v*",
  ])
    .split("\n")
    .find((candidate) => candidate && candidate !== tag);
  const hashes = command("git", [
    "log",
    "--format=%H",
    previous ? `${previous}..${revision}` : revision,
  ])
    .split("\n")
    .filter(Boolean);
  const commits = hashes.map((hash) => ({
    hash,
    message: command("git", ["show", "-s", "--format=%B", hash]),
  }));
  const context = {
    cwd: process.cwd(),
    env: process.env,
    options: { repositoryUrl: "https://github.com/manziman/paseo-gateway.git" },
    branch: { name: "alpha", type: "prerelease", prerelease: "alpha", channel: "alpha" },
    nextRelease: { version, gitTag: tag, gitHead: revision, channel: "alpha" },
    lastRelease: previous
      ? { gitTag: previous, gitHead: command("git", ["rev-parse", `${previous}^{commit}`]) }
      : {},
    commits,
    logger: console,
  };
  context.nextRelease.notes = await notesGenerator({ preset: "conventionalcommits" }, context);
  // The official plugin stages uploads in a draft. Replace only that incomplete draft,
  // after artifact verification, preserving the immutable Git tag and registry artifacts.
  if (existing)
    command("gh", [
      "api",
      "--method",
      "DELETE",
      `repos/manziman/paseo-gateway/releases/${existing.id}`,
    ]);
  return publishRelease(github, context);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await recover(process.argv[2]);
