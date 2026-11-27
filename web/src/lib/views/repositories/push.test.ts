import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlagSubject } from "@/lib/contracts/feature-flags";
import { MAX_DIFF_BYTES, type PushDeps, recordPush } from "./push";
import type { PushedCommitInput } from "./store";

// B, the first build path: the customer's CI runs `ratel push` on each commit and tells Ratel
// which commit it built, where it came from and what changed.
const PROJECT = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const VERSION = "44444444-4444-4444-8444-444444444444";
const SHA = "a".repeat(40);
const BASE = "b".repeat(40);

const GIT = {
  commit: SHA,
  dirty: false,
  repository: { id: 4242, fullName: "acme/support-agent" },
  branch: "fix/refund-once",
  pullRequest: 12,
  baseCommit: BASE,
  title: "Never refund an order twice",
  author: "octo",
};
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n";

function fakes(on = true) {
  const saved: PushedCommitInput[] = [];
  const asked: FlagSubject[] = [];
  const deps: PushDeps = {
    enabled: async (subject) => {
      asked.push(subject);
      return on;
    },
    recordPushedCommit: async (input) => {
      saved.push(input);
      return { id: "commit-1" };
    },
  };
  return { deps, saved, asked };
}

const push = (git: unknown, diff: string | null = DIFF) => ({
  organizationId: ORG,
  projectId: PROJECT,
  versionId: VERSION,
  git,
  diff,
});

test("a commit pushed from CI is recorded with its version, its base and its diff", async () => {
  const { deps, saved, asked } = fakes();
  assert.deepEqual(await recordPush(push(GIT), deps), { recorded: true, commitId: "commit-1" });
  assert.deepEqual(asked, [{ organizationId: ORG, projectId: PROJECT }]);
  assert.deepEqual(saved, [
    {
      projectId: PROJECT,
      repositoryId: 4242,
      sha: SHA,
      baseSha: BASE,
      branch: "fix/refund-once",
      pullRequest: 12,
      title: "Never refund an order twice",
      author: "octo",
      sandboxVersionId: VERSION,
      diff: DIFF,
      diffTruncated: false,
    },
  ]);
});

test("with the flag off nothing is recorded, and the push goes on as before", async () => {
  const { deps, saved } = fakes(false);
  assert.deepEqual(await recordPush(push(GIT), deps), { recorded: false, reason: "flag off" });
  assert.equal(saved.length, 0);
});

test("a push without a repository, or from a tree with uncommitted changes, is no commit", async () => {
  const { deps, saved } = fakes();
  // What `ratel push` sends today, from a laptop.
  assert.deepEqual(await recordPush(push({ commit: SHA, dirty: false }), deps), {
    recorded: false,
    reason: "no repository",
  });
  assert.deepEqual(await recordPush(push({ ...GIT, dirty: true }), deps), {
    recorded: false,
    reason: "uncommitted changes",
  });
  assert.deepEqual(await recordPush(push(null), deps), {
    recorded: false,
    reason: "no repository",
  });
  assert.equal(saved.length, 0);
});

test("git details that are not well formed are refused", async () => {
  const { deps } = fakes();
  for (const git of [
    { ...GIT, commit: "main" },
    { ...GIT, baseCommit: "HEAD~1" },
    { ...GIT, repository: { id: -1, fullName: "x/y" } },
    { ...GIT, pullRequest: 0 },
    { ...GIT, branch: "" },
  ]) {
    assert.deepEqual(await recordPush(push(git), deps), {
      recorded: false,
      reason: "invalid git details",
    });
  }
});

test("a diff over the cap is not kept, and is marked so every eval runs", async () => {
  const { deps, saved } = fakes();
  await recordPush(push(GIT, "x".repeat(MAX_DIFF_BYTES + 1)), deps);
  assert.equal(saved[0].diff, null);
  assert.equal(saved[0].diffTruncated, true);

  await recordPush(push({ ...GIT, baseCommit: null }, null), deps);
  assert.equal(saved[1].diff, null);
  assert.equal(saved[1].diffTruncated, false);
  assert.equal(saved[1].baseSha, null);
});

test("a long title is cut to its first line and 200 characters", async () => {
  const { deps, saved } = fakes();
  await recordPush(push({ ...GIT, title: `${"t".repeat(300)}\nbody` }), deps);
  assert.equal(saved[0].title, "t".repeat(200));
});
