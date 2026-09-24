export const analyzer = {
  preset: "conventionalcommits",
  releaseRules: [
    { type: "build", scope: "deps", release: "patch" },
    { type: "build", scope: "runtime", release: "patch" },
    { type: "fix", scope: "chart", release: "patch" },
  ],
};

export const github = {
  draftRelease: true,
  assets: [{ path: "release-assets/*" }],
  successComment: false,
  failComment: false,
  failTitle: false,
  labels: false,
  releasedLabels: false,
};

export default {
  branches: ["main", { name: "alpha", prerelease: "alpha", channel: "alpha" }],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release expands this template.
  tagFormat: "v${version}",
  plugins: [
    ["@semantic-release/commit-analyzer", analyzer],
    ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
    [
      "@semantic-release/exec",
      {
        // Reserve the Git tag before registry writes so source fixes advance the version.
        verifyReleaseCmd:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: official exec expands the release context.
          "node scripts/release-artifacts.mjs --verify ${nextRelease.version} ${nextRelease.gitHead}",
        publishCmd:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: official exec expands the release context.
          "node scripts/release-artifacts.mjs ${nextRelease.version} ${nextRelease.gitHead} 1>&2",
      },
    ],
    ["@semantic-release/github", github],
  ],
};
