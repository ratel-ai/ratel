import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  loadShipmentCommits,
  RECENT_COMMITS,
} from "@/lib/views/code-handoff/deploy/shipment-commits";
import {
  type CodeHandoffDb,
  linkRepo,
  markCommitsDeployed,
  recordRepoCommits,
} from "@/lib/views/code-handoff/store";

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const SHIPMENT = "33333333-3333-4333-8333-333333333333";
const OTHER = "33333333-3333-4333-8333-333333333334";

test("loadShipmentCommits reads the carrier and the recent commits up to it; none for a shipment no commit carried", async () => {
  const client = await createMigratedPGlite();
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a');
    `);
    const db = drizzle(client, { schema }) as unknown as CodeHandoffDb;
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
      db,
    );
    const sha = (seq: number) => seq.toString(16).padStart(40, "0");
    const commits = Array.from({ length: 14 }, (_, index) => ({
      sha: sha(index + 1),
      message: `commit ${index + 1}`,
      authorLogin: "ana",
      pushedAt: new Date("2026-11-18T10:00:00Z"),
      seq: index + 1,
      fixIds: [],
    }));
    await recordRepoCommits(link.id, commits, db);
    await markCommitsDeployed(link.id, [sha(2), sha(12)], new Date(), [SHIPMENT], db);

    const view = await loadShipmentCommits(PROJECT, SHIPMENT, db);
    assert.ok(view);
    assert.equal(view.repo.fullName, "acme/agent");
    assert.equal(view.commits[0].sha, sha(12), "nothing after the newest carrier");
    assert.equal(view.commits.length, RECENT_COMMITS + 1, "the recent ten plus the older carrier");
    assert.deepEqual(
      view.commits.filter((row) => row.carried).map((row) => row.sha),
      [sha(12), sha(2)],
    );
    assert.equal(await loadShipmentCommits(PROJECT, OTHER, db), null);
    assert.equal(await loadShipmentCommits(PROJECT, "not-a-uuid", db), null);
  } finally {
    await client.close();
  }
});
