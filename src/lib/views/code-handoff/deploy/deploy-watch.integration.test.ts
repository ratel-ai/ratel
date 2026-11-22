import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  claimCommit,
  findCommitsBySha,
  findShipment,
  listLinksAwaitingDeploy,
  listUndeployedTaggedCommits,
  nextCommitSeq,
  readMatchingServiceVersions,
  releaseCommit,
  setCommitShipments,
} from "@/lib/views/code-handoff/deploy/commits";
import { type RecordDeployDeps, recordDeploy } from "@/lib/views/code-handoff/deploy/deployed";
import { detectDeploysByVersion } from "@/lib/views/code-handoff/deploy/detect-by-version";
import { createPushHandler } from "@/lib/views/code-handoff/deploy/on-push";
import { signWebhookBody } from "@/lib/views/code-handoff/github/webhook-signature";
import {
  type CodeHandoffDb,
  linkRepo,
  listRepoCommits,
  listRepoLinksByRepo,
  recordRepoCommits,
} from "@/lib/views/code-handoff/store";
import { createGitHubWebhookHandler } from "@/lib/views/code-handoff/webhook-handler";
import { createFixShipment, type LoopDb } from "@/lib/views/fixes/loop-queries";
import { recordFixShipment } from "@/lib/views/fixes/record-shipment";
import type { Fix } from "@/lib/views/fixes/types";

/** RC-920, RC-993 end to end on pglite: push → spans with the sha → drain step → one shipment. */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const FIX = "craft:0b6c3a8e-1f2d-4c5b-9a7e-3d2c1b0a9f8e";
const SECRET = "test-webhook-secret";
const TAGGED = "0123456789abcdef0123456789abcdef01234567";
const LATER = "fedcba9876543210fedcba9876543210fedcba98";

const MINUTE = 60_000;
const NO_FLAGS = {
  isConfigured: () => false,
  evaluate: async () => false,
  readOverride: () => undefined,
};
const FAKE_FIX = {
  id: FIX,
  title: "Tighten the search tool",
  aliases: [],
  issues: [],
  intent: null,
  subject: { tasks: [], tools: [], topics: [] },
  source: "craft",
  sourceId: "x",
} as unknown as Fix;

/** A project linked to a repo, two tagged commits pushed two hours ago, and the drain step on this database. */
async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a');
  `);
  const db = drizzle(client, { schema });
  const store = db as unknown as CodeHandoffDb;
  const link = await linkRepo(
    {
      projectId: PROJECT,
      installationId: 9,
      repoId: 501,
      owner: "acme",
      name: "agent",
      defaultBranch: "main",
      linkedBy: "user_a",
    },
    store,
  );

  const webhook = createGitHubWebhookHandler(
    {
      webhookSecret: () => SECRET,
      listRepoLinksByInstallation: async () => [],
      deleteRepoLinks: async () => 0,
    },
    {
      push: createPushHandler({
        listRepoLinksByRepo: (repoId) => listRepoLinksByRepo(repoId, store),
        nextCommitSeq: (repoLinkId) => nextCommitSeq(repoLinkId, store),
        recordRepoCommits: (repoLinkId, commits) => recordRepoCommits(repoLinkId, commits, store),
      }),
    },
  );
  const pushedAt = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MINUTE).toISOString();
  const body = JSON.stringify({
    ref: "refs/heads/main",
    installation: { id: 9 },
    repository: { id: 501 },
    commits: [
      {
        id: TAGGED,
        message: `Tighten the search tool\n\nratel-fix: ${FIX}`,
        timestamp: pushedAt(120),
        author: { username: "ana" },
      },
      {
        id: LATER,
        message: `Later work\n\nratel-fix: ${FIX}`,
        timestamp: pushedAt(115),
        author: { username: "ana" },
      },
    ],
  });
  const pushed = await webhook(
    new Request("http://localhost/api/github/webhook", {
      method: "POST",
      body,
      headers: { "x-github-event": "push", "x-hub-signature-256": signWebhookBody(body, SECRET) },
    }),
  );
  assert.deepEqual(await pushed.json(), { removed: 0, stored: 2 });

  let span = 0;
  const insertSpan = (version: string, minutesAgo = 0) => {
    const at = new Date(Date.now() - minutesAgo * MINUTE).toISOString();
    span++;
    return client.query(
      `insert into otel_spans (id, project_id, trace_id, span_id, name, kind, span_class, started_at, ended_at, duration_ms, status_code, attributes)
       values (gen_random_uuid(), $1, $2, $3, 'agent', 1, 'agent', $4, $4, 1, 0, $5)`,
      [PROJECT, `t${span}`, `s${span}`, at, JSON.stringify({ "service.version": version })],
    );
  };

  const recordDeployDeps: RecordDeployDeps = {
    findCommitsBySha: (repoLinkId, prefix, limit) =>
      findCommitsBySha(repoLinkId, prefix, limit, store),
    listUndeployedTaggedCommits: (repoLinkId, maxSeq) =>
      listUndeployedTaggedCommits(repoLinkId, maxSeq, store),
    claimCommit: (commitId, at) => claimCommit(commitId, at, store),
    releaseCommit: (commitId) => releaseCommit(commitId, store),
    setCommitShipments: (commitId, ids) => setCommitShipments(commitId, ids, store),
    loadProjectFixes: async () => (fixId) => (fixId === FIX ? FAKE_FIX : null),
    recordFixShipment: (input) =>
      recordFixShipment(input, {
        createFixShipment: (shipment) =>
          createFixShipment(shipment, db as unknown as LoopDb, { flagDeps: NO_FLAGS }),
        recordLineage: async () => undefined as never,
        trackServerEvent: async () => undefined,
      }),
    findShipment: (projectId, fixId, version) => findShipment(projectId, fixId, version, store),
    now: () => new Date(),
  };
  const step = () =>
    detectDeploysByVersion({
      listLinksAwaitingDeploy: () => listLinksAwaitingDeploy(store),
      listPendingCommits: (repoLinkId) =>
        listUndeployedTaggedCommits(repoLinkId, Number.MAX_SAFE_INTEGER, store),
      readMatchingServiceVersions: (projectId, candidates, since) =>
        readMatchingServiceVersions(projectId, candidates, since, db as unknown as BoundReadDb),
      recordDeploy: (row, sha) => recordDeploy(row, sha, "service_version", recordDeployDeps),
      now: () => new Date(),
    });
  const shipments = async () =>
    (
      await client.query<{ fix_id: string; version: string; shipped_by: string; notes: string }>(
        "select fix_id, version, shipped_by, notes from fix_shipments",
      )
    ).rows;
  return { client, store, link, step, insertSpan, shipments };
}

test("push, then spans with the sha, then the drain step: one fix_shipments row with version = sha", async () => {
  const { client, store, link, step, insertSpan, shipments } = await setup();
  try {
    await insertSpan(TAGGED.slice(0, 7));
    assert.deepEqual(await step(), { links: 1, shipped: 1 });
    assert.deepEqual(
      await step(),
      { links: 1, shipped: 0 },
      "a second drain records no second shipment",
    );

    assert.deepEqual(await shipments(), [
      { fix_id: FIX, version: TAGGED, shipped_by: "github:9", notes: "Tighten the search tool" },
    ]);
    const commits = await listRepoCommits(link.id, store);
    assert.equal(commits[0].shipmentIds.length, 1);
    assert.notEqual(commits[0].deployedAt, null);
    assert.equal(commits[1].deployedAt, null, "the later commit is not deployed yet");
  } finally {
    await client.close();
  }
});

test("the pending sha is found in one step among 60 other distinct versions", async () => {
  const { client, step, insertSpan, shipments } = await setup();
  try {
    for (let index = 0; index < 60; index++) await insertSpan(`v1.0.${index}`);
    await insertSpan(TAGGED);
    for (let index = 0; index < 60; index++) await insertSpan(`release-${index}`);
    assert.deepEqual(await step(), { links: 1, shipped: 1 });
    assert.equal((await shipments())[0]?.version, TAGGED);
  } finally {
    await client.close();
  }
});

test("a span that started more than ten minutes ago, after the push, is found", async () => {
  const { client, step, insertSpan, shipments } = await setup();
  try {
    await insertSpan(TAGGED, 45);
    assert.deepEqual(await step(), { links: 1, shipped: 1 });
    assert.equal((await shipments())[0]?.version, TAGGED);
  } finally {
    await client.close();
  }
});

test("a span that started before the push is not a deploy of it", async () => {
  const { client, step, insertSpan, shipments } = await setup();
  try {
    await insertSpan(TAGGED, 180);
    assert.deepEqual(await step(), { links: 1, shipped: 0 });
    assert.deepEqual(await shipments(), []);
  } finally {
    await client.close();
  }
});

test("one-shipment-per-fix on pglite: after an insert whose write-back failed, the drain step reuses the stored shipment", async () => {
  const { client, store, link, step, insertSpan, shipments } = await setup();
  try {
    // The state a failed run leaves: the shipment row exists, the commit is unclaimed with no id.
    const { rows } = await client.query<{ id: string }>(
      "insert into fix_shipments (project_id, fix_id, version, shipped_by) values ($1, $2, $3, 'github:9') returning id",
      [PROJECT, FIX, TAGGED],
    );
    assert.equal(await findShipment(PROJECT, FIX, LATER, store), null);
    await insertSpan(TAGGED);

    assert.deepEqual(await step(), { links: 1, shipped: 0 });
    assert.equal((await shipments()).length, 1, "no second fix_shipments row");
    const [tagged] = await listRepoCommits(link.id, store);
    assert.deepEqual(tagged.shipmentIds, [rows[0].id]);
    assert.notEqual(tagged.deployedAt, null);
  } finally {
    await client.close();
  }
});
