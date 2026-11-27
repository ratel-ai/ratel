import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as platform from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import * as repositories from "./schema";
import * as store from "./store";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const SHA = "a".repeat(40);

let client: Awaited<ReturnType<typeof createMigratedPGlite>>;
let db: ReturnType<typeof getDb>;

const LINK = {
  projectId: PROJECT,
  repositoryId: 4242,
  fullName: "acme/support-agent",
  installationId: 77,
  defaultBranch: "main",
  linkedBy: "user_1",
};
const COMMIT = {
  projectId: PROJECT,
  repositoryId: 4242,
  sha: SHA,
  baseSha: "b".repeat(40),
  branch: "main",
  pullRequest: null,
  title: "Never refund an order twice",
  author: "octo",
  status: "queued" as const,
  reason: null,
};

before(async () => {
  client = await createMigratedPGlite();
  db = drizzle(client, { schema: { ...platform, ...repositories } }) as unknown as ReturnType<
    typeof getDb
  >;
  await client.exec(`
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Support', 'support'),
      ('${OTHER}', '${ORG}', 'Other', 'other');
  `);
});
beforeEach(async () => {
  await client.exec("delete from project_repositories; delete from repository_commits");
});
after(async () => {
  await client.close();
});

test("a project links several repositories; linking one again updates it", async () => {
  await store.linkRepository(LINK, db);
  const [first] = await store.listRepositoryLinks(PROJECT, db);
  assert.equal(first.fullName, "acme/support-agent");
  assert.deepEqual(first.versionBranches, []);
  assert.equal(first.pullRequests, true);
  assert.equal(first.configPath, "ratel.yaml");

  await store.linkRepository(
    { ...LINK, repositoryId: 5151, fullName: "acme/tools", configPath: "agent/ratel.yaml" },
    db,
  );
  await store.linkRepository({ ...LINK, versionBranches: ["release/*"] }, db);
  const links = await store.listRepositoryLinks(PROJECT, db);
  assert.deepEqual(
    links.map((link) => [link.fullName, link.versionBranches, link.configPath]),
    [
      ["acme/support-agent", ["release/*"], "ratel.yaml"],
      ["acme/tools", [], "agent/ratel.yaml"],
    ],
  );

  await store.unlinkRepository(PROJECT, 4242, db);
  assert.deepEqual(
    (await store.listRepositoryLinks(PROJECT, db)).map((link) => link.repositoryId),
    [5151],
  );
});

test("every project that links a repository, with its organization", async () => {
  await store.linkRepository(LINK, db);
  await store.linkRepository({ ...LINK, projectId: OTHER, configPath: "agents/b/ratel.yaml" }, db);
  const links = await store.linksForRepository(4242, db);
  assert.deepEqual(
    links.map((link) => [link.projectId, link.organizationId, link.configPath]).sort(),
    [
      [OTHER, ORG, "agents/b/ratel.yaml"],
      [PROJECT, ORG, "ratel.yaml"],
    ].sort(),
  );
  assert.deepEqual(await store.linksForRepository(9999, db), []);
});

test("a commit is recorded once; a pull request naming it later adds its number", async () => {
  const first = await store.recordCommit(COMMIT, db);
  assert.equal(first.created, true);

  const again = await store.recordCommit({ ...COMMIT, pullRequest: 12, branch: "fix/x" }, db);
  assert.equal(again.created, false);
  assert.equal(again.id, first.id);

  const [row] = await store.listCommits(PROJECT, 10, db);
  assert.equal(row.pullRequest, 12);
  assert.equal(row.branch, "main");
  assert.equal(row.status, "queued");
});

test("a commit moves on, and keeps the version it built", async () => {
  const { id } = await store.recordCommit(COMMIT, db);
  const version = "44444444-4444-4444-8444-444444444444";
  await store.markCommit(id, { status: "ready", sandboxVersionId: version }, db);
  const [row] = await store.listCommits(PROJECT, 10, db);
  assert.equal(row.status, "ready");
  assert.equal(row.sandboxVersionId, version);

  // A redelivery never moves a commit back to queued.
  await store.recordCommit(COMMIT, db);
  assert.equal((await store.listCommits(PROJECT, 10, db))[0].status, "ready");
});

test("the newest commits come first, per project", async () => {
  await store.recordCommit(COMMIT, db);
  await store.recordCommit({ ...COMMIT, sha: "c".repeat(40), title: "Second" }, db);
  // Two inserts can share a timestamp: give them their own.
  await client.exec(
    `update repository_commits set received_at = now() + interval '1 second' where title = 'Second'`,
  );
  await store.recordCommit({ ...COMMIT, projectId: OTHER, sha: "d".repeat(40) }, db);
  const rows = await store.listCommits(PROJECT, 10, db);
  assert.deepEqual(
    rows.map((row) => row.title),
    ["Second", "Never refund an order twice"],
  );
  assert.equal((await store.listCommits(PROJECT, 1, db)).length, 1);
});
