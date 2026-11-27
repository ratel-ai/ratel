import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { FlagSubject } from "@/lib/contracts/feature-flags";
import { type ReceiveDeps, receiveWebhook } from "./receive";
import type { CommitInput, RepositoryLink } from "./store";

const SECRET = "whsec-test-0123456789";
const SHA = "a".repeat(40);
const ON = "11111111-1111-4111-8111-111111111111";
const OFF = "33333333-3333-4333-8333-333333333333";
const ORG = "22222222-2222-4222-8222-222222222222";

const link = (projectId: string, over: Partial<RepositoryLink> = {}): RepositoryLink => ({
  projectId,
  organizationId: ORG,
  provider: "github",
  repositoryId: 4242,
  fullName: "acme/support-agent",
  installationId: 77,
  defaultBranch: "main",
  versionBranches: [],
  pullRequests: true,
  configPath: "ratel.yaml",
  linkedBy: "user_1",
  linkedAt: new Date("2026-11-27T10:00:00Z"),
  ...over,
});

const pushBody = (branch = "main") =>
  JSON.stringify({
    ref: `refs/heads/${branch}`,
    before: "b".repeat(40),
    after: SHA,
    repository: { id: 4242, full_name: "acme/support-agent" },
    installation: { id: 77 },
    head_commit: { id: SHA, message: "Refund once", author: { username: "octo" } },
  });

const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

function fakes(links: RepositoryLink[], on: string[] = [ON]) {
  const recorded: CommitInput[] = [];
  const asked: FlagSubject[] = [];
  const deps: ReceiveDeps = {
    secret: SECRET,
    linksForRepository: async (id) => links.filter((l) => l.repositoryId === id),
    enabled: async (subject) => {
      asked.push(subject);
      return on.includes(subject.projectId ?? "");
    },
    recordCommit: async (input) => {
      recorded.push(input);
      return { id: `commit-${recorded.length}`, created: true };
    },
  };
  return { deps, recorded, asked };
}

const deliver = (deps: ReceiveDeps, body: string, event = "push", signature = sign(body)) =>
  receiveWebhook({ event, signature, body }, deps);

test("without a webhook secret the route does not exist", async () => {
  const { deps, recorded } = fakes([link(ON)]);
  const result = await deliver({ ...deps, secret: undefined }, pushBody());
  assert.equal(result.status, 404);
  assert.equal(recorded.length, 0);
});

test("a delivery GitHub did not sign is refused before it is read", async () => {
  const { deps, recorded, asked } = fakes([link(ON)]);
  const result = await deliver(deps, pushBody(), "push", "sha256=00");
  assert.equal(result.status, 401);
  assert.equal(recorded.length, 0);
  assert.equal(asked.length, 0);
});

test("a signed body that is not JSON is a bad request", async () => {
  const { deps } = fakes([link(ON)]);
  assert.equal((await deliver(deps, "{not json")).status, 400);
});

test("a push to the default branch is queued for each project with the flag on", async () => {
  const { deps, recorded, asked } = fakes([link(ON), link(OFF)]);
  const result = await deliver(deps, pushBody());
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, {
    recorded: [{ projectId: ON, commitId: "commit-1", status: "queued", created: true }],
    skipped: [],
  });
  assert.deepEqual(
    recorded.map((c) => [c.projectId, c.sha, c.baseSha, c.branch, c.status, c.title]),
    [[ON, SHA, "b".repeat(40), "main", "queued", "Refund once"]],
  );
  assert.deepEqual(asked, [
    { organizationId: ORG, projectId: ON },
    { organizationId: ORG, projectId: OFF },
  ]);
});

test("with the flag off everywhere, a linked repository reads as an unlinked one", async () => {
  const off = fakes([link(OFF)]);
  const unlinked = fakes([]);
  const a = await deliver(off.deps, pushBody());
  const b = await deliver(unlinked.deps, pushBody());
  assert.deepEqual(a, b);
  assert.deepEqual(a, { status: 202, body: { ignored: "no project takes this repository" } });
  assert.equal(off.recorded.length, 0);
});

test("a branch that makes no versions is skipped, with why, and not recorded", async () => {
  const { deps, recorded } = fakes([link(ON)]);
  const result = await deliver(deps, pushBody("wip/try"));
  assert.deepEqual(result.body, {
    recorded: [],
    skipped: [{ projectId: ON, reason: "branch wip/try makes no versions" }],
  });
  assert.equal(recorded.length, 0);
});

test("a fork's pull request is skipped and not recorded", async () => {
  const { deps, recorded } = fakes([link(ON)]);
  const body = JSON.stringify({
    action: "opened",
    number: 12,
    repository: { id: 4242, full_name: "acme/support-agent" },
    installation: { id: 77 },
    pull_request: {
      title: "Refund once",
      user: { login: "stranger" },
      head: { sha: SHA, ref: "patch-1", repo: { id: 9999 } },
      base: { sha: "b".repeat(40), ref: "main", repo: { id: 4242 } },
    },
  });
  const result = await deliver(deps, body, "pull_request");
  assert.deepEqual(result.body, {
    recorded: [],
    skipped: [{ projectId: ON, reason: "pull requests from forks are ignored" }],
  });
  assert.equal(recorded.length, 0);
});

test("events that name no commit are acknowledged and ignored", async () => {
  const { deps, recorded } = fakes([link(ON)]);
  const result = await deliver(deps, JSON.stringify({ zen: "hi" }), "ping");
  assert.deepEqual(result, { status: 202, body: { ignored: "ping" } });
  assert.equal(recorded.length, 0);
});

test("a flag read that fails counts as off", async () => {
  const { deps, recorded } = fakes([link(ON)]);
  const result = await deliver(
    {
      ...deps,
      enabled: async () => {
        throw new Error("flag service down");
      },
    },
    pushBody(),
  );
  assert.deepEqual(result.body, { ignored: "no project takes this repository" });
  assert.equal(recorded.length, 0);
});
