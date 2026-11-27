import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { decideCommit, parseGitHubEvent, verifySignature } from "./webhook";

const SECRET = "whsec-test-0123456789";
const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const REPO = { id: 4242, full_name: "acme/support-agent", default_branch: "main" };
const SHA = "a".repeat(40);
const BEFORE = "b".repeat(40);

const push = (over: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  before: BEFORE,
  after: SHA,
  deleted: false,
  repository: REPO,
  installation: { id: 77 },
  head_commit: {
    id: SHA,
    message: "Never refund an order twice\n\nThe tool now checks refundedAt.",
    author: { username: "octo" },
  },
  ...over,
});

const pullRequest = (action: string, fork = false) => ({
  action,
  number: 12,
  repository: REPO,
  installation: { id: 77 },
  pull_request: {
    title: "Refund once",
    user: { login: "octo" },
    head: { sha: SHA, ref: "fix/refund-once", repo: fork ? { id: 9999 } : { id: REPO.id } },
    base: { sha: BEFORE, ref: "main", repo: { id: REPO.id } },
  },
});

test("a delivery signed with the secret is accepted, any other is not", () => {
  const body = JSON.stringify(push());
  assert.equal(verifySignature(SECRET, body, sign(body)), true);
  assert.equal(verifySignature(SECRET, body, sign(body, "another-secret")), false);
  assert.equal(verifySignature(SECRET, `${body} `, sign(body)), false);
  assert.equal(verifySignature(SECRET, body, null), false);
  assert.equal(verifySignature(SECRET, body, "sha256=short"), false);
  assert.equal(verifySignature(SECRET, body, sign(body).replace("sha256=", "sha1=")), false);
});

test("a push to a branch is its head commit", () => {
  assert.deepEqual(parseGitHubEvent("push", push()), {
    kind: "push",
    repositoryId: 4242,
    fullName: "acme/support-agent",
    installationId: 77,
    sha: SHA,
    baseSha: BEFORE,
    branch: "main",
    pullRequest: null,
    fromFork: false,
    title: "Never refund an order twice",
    author: "octo",
  });
});

test("tags, deleted branches and pushes with no commit are ignored", () => {
  assert.deepEqual(parseGitHubEvent("push", push({ ref: "refs/tags/v1" })), {
    ignored: "not a branch",
  });
  assert.deepEqual(parseGitHubEvent("push", push({ deleted: true, after: "0".repeat(40) })), {
    ignored: "branch deleted",
  });
  assert.deepEqual(parseGitHubEvent("push", push({ head_commit: null })), {
    ignored: "no commit",
  });
  // A new branch compares to nothing yet.
  const created = parseGitHubEvent("push", push({ before: "0".repeat(40) }));
  assert.equal("kind" in created && created.baseSha, null);
});

test("a pull request opened or updated is its head commit against its base", () => {
  for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
    assert.deepEqual(parseGitHubEvent("pull_request", pullRequest(action)), {
      kind: "pull_request",
      repositoryId: 4242,
      fullName: "acme/support-agent",
      installationId: 77,
      sha: SHA,
      baseSha: BEFORE,
      branch: "fix/refund-once",
      pullRequest: 12,
      fromFork: false,
      title: "Refund once",
      author: "octo",
    });
  }
  assert.deepEqual(parseGitHubEvent("pull_request", pullRequest("closed")), {
    ignored: "pull request closed",
  });
  const fork = parseGitHubEvent("pull_request", pullRequest("opened", true));
  assert.equal("kind" in fork && fork.fromFork, true);
});

test("other events and payloads that are not GitHub's are ignored", () => {
  assert.deepEqual(parseGitHubEvent("ping", { zen: "Keep it simple." }), { ignored: "ping" });
  assert.deepEqual(parseGitHubEvent("issues", {}), { ignored: "event issues" });
  assert.deepEqual(parseGitHubEvent("push", { ref: 1 }), { ignored: "unreadable payload" });
  assert.deepEqual(parseGitHubEvent("push", null), { ignored: "unreadable payload" });
});

const LINK = { defaultBranch: "main", versionBranches: [] as string[], pullRequests: true };
const event = (over: Record<string, unknown> = {}) => {
  const parsed = parseGitHubEvent("push", push(over));
  assert.ok("kind" in parsed);
  return parsed;
};

test("the default branch makes versions; another branch only when its pattern is listed", () => {
  assert.deepEqual(decideCommit(LINK, event()), { action: "build" });
  assert.deepEqual(decideCommit(LINK, event({ ref: "refs/heads/release/2" })), {
    action: "skip",
    reason: "branch release/2 makes no versions",
  });
  assert.deepEqual(
    decideCommit(
      { ...LINK, versionBranches: ["release/*"] },
      event({ ref: "refs/heads/release/2" }),
    ),
    { action: "build" },
  );
});

test("a pull request from the repository builds; one from a fork is ignored", () => {
  const own = parseGitHubEvent("pull_request", pullRequest("opened"));
  const fork = parseGitHubEvent("pull_request", pullRequest("opened", true));
  assert.ok("kind" in own && "kind" in fork);
  assert.deepEqual(decideCommit(LINK, own), { action: "build" });
  assert.deepEqual(decideCommit(LINK, fork), {
    action: "skip",
    reason: "pull requests from forks are ignored",
  });
  assert.deepEqual(decideCommit({ ...LINK, pullRequests: false }, own), {
    action: "skip",
    reason: "pull requests make no versions for this project",
  });
});
