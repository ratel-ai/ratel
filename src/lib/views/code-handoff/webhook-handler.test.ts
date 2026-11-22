import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoLinkRow } from "@/lib/views/code-handoff/schema";
import { signWebhookBody } from "./github/webhook-signature";
import { createGitHubWebhookHandler, type GitHubWebhookDeps } from "./webhook-handler";

const SECRET = "test-webhook-secret";
const FLAGGED = "11111111-1111-4111-8111-111111111111";
const UNFLAGGED = "11111111-1111-4111-8111-111111111112";

function link(id: string, projectId: string, installationId: number, repoId: number): RepoLinkRow {
  return {
    id,
    projectId,
    installationId,
    repoId,
    owner: "acme",
    name: `r${repoId}`,
    defaultBranch: "main",
    linkedBy: "user_a",
    createdAt: new Date(0),
  };
}

/** An in-memory link table; every write is recorded. */
function harness(options: { secret?: string | null; flagOff?: boolean } = {}) {
  let links = [
    link("l1", FLAGGED, 9, 501),
    link("l2", UNFLAGGED, 9, 502),
    link("l3", FLAGGED, 10, 503),
  ];
  const writes: string[][] = [];
  const deps: GitHubWebhookDeps = {
    webhookSecret: () => (options.secret === undefined ? SECRET : options.secret),
    flagEnabledForProject: async (projectId) => !options.flagOff && projectId === FLAGGED,
    listRepoLinksByInstallation: async (installationId) =>
      links.filter((row) => row.installationId === installationId),
    deleteRepoLinks: async (ids) => {
      writes.push(ids);
      const before = links.length;
      links = links.filter((row) => !ids.includes(row.id));
      return before - links.length;
    },
  };
  return {
    handler: createGitHubWebhookHandler(deps),
    writes,
    links: () => links.map((row) => row.id),
  };
}

function delivery(event: string, payload: unknown, signature?: string | null): Request {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "x-github-event": event, "x-github-delivery": "d-1" };
  const sig = signature === undefined ? signWebhookBody(body, SECRET) : signature;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  return new Request("http://localhost/api/github/webhook", { method: "POST", body, headers });
}

test("a bad or missing signature gets 401 and writes nothing", async () => {
  const { handler, writes } = harness();
  const payload = { action: "deleted", installation: { id: 9 } };
  assert.equal(
    (await handler(delivery("installation", payload, signWebhookBody("{}", SECRET)))).status,
    401,
  );
  assert.equal((await handler(delivery("installation", payload, null))).status, 401);
  assert.deepEqual(writes, []);
});

test("signed installation deleted removes the installation's links where the flag is on", async () => {
  const { handler, links } = harness();
  const response = await handler(
    delivery("installation", { action: "deleted", installation: { id: 9 } }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removed: 1 });
  assert.deepEqual(links(), ["l2", "l3"]);
});

test("signed installation_repositories removed removes only those repos' links", async () => {
  const { handler, links } = harness();
  const payload = {
    action: "removed",
    installation: { id: 9 },
    repositories_removed: [{ id: 501 }, { id: 999 }],
  };
  const response = await handler(delivery("installation_repositories", payload));
  assert.deepEqual(await response.json(), { removed: 1 });
  assert.deepEqual(links(), ["l2", "l3"]);
});

test("an unknown event, or another action, answers 200 and writes nothing", async () => {
  const { handler, writes } = harness();
  const unknown = await handler(delivery("star", { action: "created" }));
  assert.equal(unknown.status, 200);
  assert.deepEqual(await unknown.json(), { ignored: true });
  assert.equal((await handler(delivery("toString", {}))).status, 200);
  assert.equal(
    (await handler(delivery("installation", { action: "created", installation: { id: 9 } })))
      .status,
    200,
  );
  assert.deepEqual(writes.flat(), []);
});

test("with the flag off the handler writes nothing", async () => {
  const { handler, links } = harness({ flagOff: true });
  const deleted = await handler(
    delivery("installation", { action: "deleted", installation: { id: 9 } }),
  );
  assert.deepEqual(await deleted.json(), { removed: 0 });
  await handler(
    delivery("installation_repositories", {
      action: "removed",
      installation: { id: 10 },
      repositories_removed: [{ id: 503 }],
    }),
  );
  assert.deepEqual(links(), ["l1", "l2", "l3"]);
});

test("without a configured secret the webhook answers 503 and writes nothing", async () => {
  const { handler, writes } = harness({ secret: null });
  assert.equal(
    (await handler(delivery("installation", { action: "deleted", installation: { id: 9 } })))
      .status,
    503,
  );
  assert.deepEqual(writes, []);
});

test("with the real deps and no App settings (absent or REPLACE_ME) the webhook answers 503 before any read", async () => {
  const names = [
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
  ];
  const saved = names.map((name) => process.env[name]);
  try {
    for (const value of [undefined, "REPLACE_ME"]) {
      for (const name of names) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      const response = await createGitHubWebhookHandler()(
        delivery(
          "installation",
          { action: "deleted", installation: { id: 9 } },
          signWebhookBody("{}", "REPLACE_ME"),
        ),
      );
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "not_configured" });
    }
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  }
});
