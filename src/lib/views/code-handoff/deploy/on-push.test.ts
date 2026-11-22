import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoLinkRow } from "@/lib/views/code-handoff/schema";
import { signWebhookBody } from "../github/webhook-signature";
import type { NewRepoCommit } from "../store";
import {
  createGitHubWebhookHandler,
  GITHUB_EVENT_HANDLERS,
  type GitHubWebhookDeps,
} from "../webhook-handler";
import { createPushHandler, type PushDeps } from "./on-push";

const SECRET = "test-webhook-secret";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const FIX = "craft:0b6c3a8e-1f2d-4c5b-9a7e-3d2c1b0a9f8e";
const LINK: RepoLinkRow = {
  id: "link-1",
  projectId: PROJECT,
  installationId: 9,
  repoId: 501,
  owner: "acme",
  name: "agent",
  defaultBranch: "main",
  linkedBy: "user_a",
  createdAt: new Date(0),
};

/** An in-memory commit table keyed by (link, sha), as the unique index is. */
function harness(options: { flagOff?: boolean } = {}) {
  const rows = new Map<string, NewRepoCommit & { repoLinkId: string }>();
  const pushDeps: PushDeps = {
    listRepoLinksByRepo: async (repoId) => (repoId === LINK.repoId ? [LINK] : []),
    nextCommitSeq: async (linkId) =>
      [...rows.values()]
        .filter((row) => row.repoLinkId === linkId)
        .reduce((max, row) => Math.max(max, row.seq), 0) + 1,
    recordRepoCommits: async (linkId, commits) => {
      let inserted = 0;
      for (const commit of commits) {
        const key = `${linkId}:${commit.sha}`;
        if (rows.has(key)) continue;
        rows.set(key, { ...commit, repoLinkId: linkId });
        inserted++;
      }
      return inserted;
    },
  };
  const deps: GitHubWebhookDeps = {
    webhookSecret: () => SECRET,
    flagEnabledForProject: async () => !options.flagOff,
    listRepoLinksByInstallation: async () => [],
    deleteRepoLinks: async () => 0,
  };
  const handler = createGitHubWebhookHandler(deps, {
    ...GITHUB_EVENT_HANDLERS,
    push: createPushHandler(pushDeps),
  });
  return { handler, rows: () => [...rows.values()] };
}

function pushPayload(overrides: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    forced: false,
    installation: { id: 9 },
    repository: { id: 501 },
    commits: [
      {
        id: "a".repeat(40),
        message: "first change",
        timestamp: "2026-11-18T10:00:00Z",
        author: { username: "ana" },
      },
      {
        id: "b".repeat(40),
        message: `Tighten the search tool description\n\nratel-fix: ${FIX}`,
        timestamp: "2026-11-18T10:01:00Z",
        author: { username: "ben" },
      },
      {
        id: "c".repeat(40),
        message: "third change",
        timestamp: "2026-11-18T10:02:00Z",
        author: { name: "No Login" },
      },
    ],
    ...overrides,
  };
}

function delivery(payload: unknown): Request {
  const body = JSON.stringify(payload);
  return new Request("http://localhost/api/github/webhook", {
    method: "POST",
    body,
    headers: {
      "x-github-event": "push",
      "x-github-delivery": "d-1",
      "x-hub-signature-256": signWebhookBody(body, SECRET),
    },
  });
}

test("push to the default branch stores every commit, in order, with the fixes its message names", async () => {
  const { handler, rows } = harness();
  const response = await handler(delivery(pushPayload()));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removed: 0, stored: 3 });

  const stored = rows();
  assert.deepEqual(
    stored.map((row) => [row.sha[0], row.seq, row.authorLogin, row.fixIds]),
    [
      ["a", 1, "ana", []],
      ["b", 2, "ben", [FIX]],
      ["c", 3, null, []],
    ],
  );
  assert.equal(stored[1].message.startsWith("Tighten the search tool description"), true);
  assert.deepEqual(stored[1].pushedAt, new Date("2026-11-18T10:01:00Z"));
});

test("push to another branch stores nothing", async () => {
  const { handler, rows } = harness();
  const response = await handler(delivery(pushPayload({ ref: "refs/heads/feature" })));
  assert.deepEqual(await response.json(), { removed: 0, stored: 0 });
  assert.deepEqual(rows(), []);
});

test("a redelivered push changes nothing", async () => {
  const { handler, rows } = harness();
  await handler(delivery(pushPayload()));
  const before = JSON.stringify(rows());
  const response = await handler(delivery(pushPayload()));
  assert.deepEqual(await response.json(), { removed: 0, stored: 0 });
  assert.equal(JSON.stringify(rows()), before);
});

test("a later push continues the sequence", async () => {
  const { handler, rows } = harness();
  await handler(delivery(pushPayload()));
  await handler(
    delivery(
      pushPayload({
        commits: [{ id: "d".repeat(40), message: "fourth", timestamp: "2026-11-18T11:00:00Z" }],
      }),
    ),
  );
  assert.deepEqual(
    rows().map((row) => row.seq),
    [1, 2, 3, 4],
  );
});

test("flag off: nothing stored", async () => {
  const { handler, rows } = harness({ flagOff: true });
  const response = await handler(delivery(pushPayload()));
  assert.deepEqual(await response.json(), { removed: 0, stored: 0 });
  assert.deepEqual(rows(), []);
});

test("a push from another installation or an unlinked repo stores nothing", async () => {
  const { handler, rows } = harness();
  await handler(delivery(pushPayload({ installation: { id: 10 } })));
  await handler(delivery(pushPayload({ repository: { id: 999 } })));
  assert.deepEqual(rows(), []);
});

test("a forced push stores the commits that are present", async () => {
  const { handler, rows } = harness();
  const response = await handler(delivery(pushPayload({ forced: true })));
  assert.deepEqual(await response.json(), { removed: 0, stored: 3 });
  assert.equal(rows().length, 3);
});

test("malformed commits are skipped", async () => {
  const { handler, rows } = harness();
  const commits = [
    { id: "e".repeat(40), message: "ok", timestamp: "2026-11-18T10:00:00Z" },
    { message: "no sha" },
    { id: "f".repeat(40), timestamp: "nope" },
  ];
  const response = await handler(delivery(pushPayload({ commits })));
  assert.deepEqual(await response.json(), { removed: 0, stored: 1 });
  assert.deepEqual(
    rows().map((row) => row.sha[0]),
    ["e"],
  );
});
