import assert from "node:assert/strict";
import test from "node:test";
import { recover } from "../scripts/release-recover.mjs";

const revision = "a".repeat(40);
const version = "1.0.0-alpha.1";
function fixture() {
  const state = {
    releases: [],
    prepared: 0,
    deleted: 0,
    published: 0,
    wrongSource: false,
    failUpload: false,
  };
  const dependencies = {
    command(binary, args) {
      if (binary === "git") {
        if (args[0] === "rev-parse")
          return state.wrongSource && args[1] !== "HEAD" ? "b".repeat(40) : revision;
        if (args[0] === "merge-base") return "";
        if (args[0] === "tag") return `v${version}`;
        if (args[0] === "log") return revision;
        if (args[0] === "show") return "feat: first candidate";
      }
      if (binary === "gh" && args.includes("DELETE")) {
        state.deleted++;
        state.releases = [];
        return "";
      }
      if (binary === "gh") return JSON.stringify([state.releases]);
      throw new Error("Unexpected command");
    },
    async prepareArtifacts(candidate, source) {
      assert.equal(candidate, version);
      assert.equal(source, revision);
      state.prepared++;
    },
    async notesGenerator() {
      return "Official release notes fixture";
    },
    async publishRelease(config, context) {
      assert.equal(config.draftRelease, true);
      assert.equal(context.nextRelease.version, version);
      state.releases = [{ id: 1, tag_name: `v${version}`, draft: true }];
      if (state.failUpload) throw new Error("Injected GitHub asset upload failure");
      state.published++;
      return { id: 1 };
    },
  };
  return { state, dependencies };
}
test("GitHub upload failure recovers tagged version without moving tag or touching public releases", async () => {
  const { state, dependencies } = fixture();
  state.failUpload = true;
  await assert.rejects(recover(version, dependencies), /upload failure/);
  assert.equal(state.deleted, 0);
  state.failUpload = false;
  await recover(version, dependencies);
  assert.equal(state.deleted, 1);
  assert.equal(state.published, 1);
  state.releases[0].draft = false;
  await assert.rejects(recover(version, dependencies), /already public/);
  assert.equal(state.prepared, 2);
});
test("recovery refuses a different source before any external mutation", async () => {
  const { state, dependencies } = fixture();
  state.wrongSource = true;
  await assert.rejects(recover(version, dependencies), /original tagged source/);
  assert.equal(state.prepared + state.deleted + state.published, 0);
});
test("failed registry verification preserves existing GitHub draft", async () => {
  const { state, dependencies } = fixture();
  state.releases = [{ id: 1, tag_name: `v${version}`, draft: true }];
  dependencies.prepareArtifacts = async () => {
    throw new Error("Injected image verification failure");
  };
  await assert.rejects(recover(version, dependencies), /verification failure/);
  assert.equal(state.deleted, 0);
});
