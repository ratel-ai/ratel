import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as platform from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { receiveWebhook } from "./receive";
import * as repositories from "./schema";
import * as store from "./store";

// The whole delivery on a migrated database: signed GitHub payloads in, commit rows out.
const SECRET = "whsec-test-0123456789";
const ORG = "22222222-2222-4222-8222-222222222222";
const ON = "11111111-1111-4111-8111-111111111111";
const OFF = "33333333-3333-4333-8333-333333333333";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

let client: Awaited<ReturnType<typeof createMigratedPGlite>>;
let db: ReturnType<typeof getDb>;

before(async () => {
  client = await createMigratedPGlite();
  db = drizzle(client, { schema: { ...platform, ...repositories } }) as unknown as ReturnType<
    typeof getDb
  >;
  await client.exec(`
    insert into projects (id, organization_id, name, slug) values
      ('${ON}', '${ORG}', 'Support', 'support'),
      ('${OFF}', '${ORG}', 'Flag off', 'flag-off');
  `);
  for (const projectId of [ON, OFF]) {
    await store.linkRepository(
      {
        projectId,
        repositoryId: 4242,
        fullName: "acme/support-agent",
        installationId: 77,
        defaultBranch: "main",
        linkedBy: "user_1",
      },
      db,
    );
  }
});
after(async () => {
  await client.close();
});

const deps = () => ({
  secret: SECRET,
  linksForRepository: (id: number) => store.linksForRepository(id, db),
  enabled: async (subject: { projectId?: string }) => subject.projectId === ON,
  recordCommit: (input: store.CommitInput) => store.recordCommit(input, db),
});

function deliver(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  return receiveWebhook({ event, signature, body }, deps());
}

const repository = { id: 4242, full_name: "acme/support-agent" };

test("a push, then the pull request of the same commit, make one version row", async () => {
  const push = await deliver("push", {
    ref: "refs/heads/main",
    before: BASE,
    after: HEAD,
    repository,
    installation: { id: 77 },
    head_commit: { id: HEAD, message: "Never refund an order twice", author: { username: "octo" } },
  });
  assert.equal(push.status, 202);

  const pr = await deliver("pull_request", {
    action: "synchronize",
    number: 12,
    repository,
    installation: { id: 77 },
    pull_request: {
      title: "Refund once",
      user: { login: "octo" },
      head: { sha: HEAD, ref: "main", repo: { id: 4242 } },
      base: { sha: BASE, ref: "main", repo: { id: 4242 } },
    },
  });
  assert.equal(pr.status, 202);
  assert.ok("recorded" in pr.body);
  assert.equal(pr.body.recorded[0].created, false);

  const rows = await store.listCommits(ON, 10, db);
  assert.deepEqual(
    rows.map((r) => [r.sha, r.baseSha, r.branch, r.pullRequest, r.status, r.title]),
    [[HEAD, BASE, "main", 12, "queued", "Never refund an order twice"]],
  );
  assert.deepEqual(await store.listCommits(OFF, 10, db), []);
});

test("a fork's pull request waits for approval; a tag push records nothing", async () => {
  const fork = "f".repeat(40);
  await deliver("pull_request", {
    action: "opened",
    number: 13,
    repository,
    installation: { id: 77 },
    pull_request: {
      title: "Patch from a stranger",
      user: { login: "stranger" },
      head: { sha: fork, ref: "patch-1", repo: { id: 9999 } },
      base: { sha: BASE, ref: "main", repo: { id: 4242 } },
    },
  });
  const tag = await deliver("push", {
    ref: "refs/tags/v1",
    before: BASE,
    after: "c".repeat(40),
    repository,
    head_commit: { id: "c".repeat(40), message: "v1" },
  });
  assert.deepEqual(tag.body, { ignored: "not a branch" });

  const rows = await store.listCommits(ON, 10, db);
  const row = rows.find((r) => r.sha === fork);
  assert.equal(row?.status, "awaiting_approval");
  assert.equal(row?.fromFork, true);
  assert.equal(rows.length, 2);
});
