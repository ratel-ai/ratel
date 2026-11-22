import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { nextCommitSeq } from "@/lib/views/code-handoff/deploy/commits";
import { type CodeHandoffDb, linkRepo, recordRepoCommits } from "@/lib/views/code-handoff/store";

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";

test("nextCommitSeq starts at 1 and continues past the highest seq of the link", async () => {
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
    assert.equal(await nextCommitSeq(link.id, db), 1);
    const commit = (sha: string, seq: number) => ({
      sha,
      message: sha,
      authorLogin: null,
      pushedAt: new Date(0),
      seq,
      fixIds: [],
    });
    await recordRepoCommits(link.id, [commit("a1", 1), commit("a2", 7)], db);
    assert.equal(await nextCommitSeq(link.id, db), 8);
  } finally {
    await client.close();
  }
});
