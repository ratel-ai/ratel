import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  type CodeHandoffDb,
  deleteRepoLinks,
  getFixHandoff,
  getRepoLink,
  linkRepo,
  listCodePointers,
  listRepoCommits,
  listRepoLinksByInstallation,
  listRepoLinksByRepo,
  MESSAGE_HEAD_MAX,
  markCommitsDeployed,
  recordFixHandoff,
  recordRepoCommits,
  replaceCodePointers,
  unlinkRepo,
} from "./store";

const ORG = "22222222-2222-4222-8222-222222222221";
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "11111111-1111-4111-8111-111111111112";
const SHIPMENT = "33333333-3333-4333-8333-333333333333";
const FIX = "craft:0b6c3a8e-1f2d-4c5b-9a7e-3d2c1b0a9f8e";

async function setup(): Promise<{ client: PGlite; db: CodeHandoffDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${P1}', '${ORG}', 'A', 'a'), ('${P2}', '${ORG}', 'B', 'b');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as CodeHandoffDb };
}

function link(projectId: string, repoId = 501, installationId = 9) {
  return {
    projectId,
    installationId,
    repoId,
    owner: "acme",
    name: `repo-${repoId}`,
    defaultBranch: "main",
    linkedBy: "user_roberto",
  };
}

test("repo_links: link, replace, read, unlink; one link per project", async () => {
  const { client, db } = await setup();
  try {
    const first = await linkRepo(link(P1), db);
    assert.equal(first.repoId, 501);
    const replaced = await linkRepo(link(P1, 502), db);
    assert.equal(replaced.id, first.id);
    assert.equal((await getRepoLink(P1, db))?.name, "repo-502");
    await linkRepo(link(P2, 502), db);
    assert.equal((await listRepoLinksByRepo(502, db)).length, 2);
    assert.equal(await unlinkRepo(P1, db), true);
    assert.equal(await unlinkRepo(P1, db), false);
    assert.equal(await getRepoLink(P1, db), null);
  } finally {
    await client.close();
  }
});

test("repo_links: listed by installation, deleted by id", async () => {
  const { client, db } = await setup();
  try {
    const a = await linkRepo(link(P1, 501, 9), db);
    await linkRepo(link(P2, 502, 10), db);
    assert.deepEqual(
      (await listRepoLinksByInstallation(9, db)).map((row) => row.projectId),
      [P1],
    );
    assert.equal(await deleteRepoLinks([], db), 0);
    assert.equal(await deleteRepoLinks([a.id], db), 1);
    assert.equal(await getRepoLink(P1, db), null);
    assert.ok(await getRepoLink(P2, db));
  } finally {
    await client.close();
  }
});

test("repo_commits: recorded once per sha, first line capped, deploy marked, gone with the link", async () => {
  const { client, db } = await setup();
  try {
    const row = await linkRepo(link(P1), db);
    const pushedAt = new Date("2026-11-17T10:00:00Z");
    const long = `${"x".repeat(300)}\n\nratel-fix: ${FIX}`;
    const commits = [
      { sha: "a1", message: long, authorLogin: "dev", pushedAt, seq: 1, fixIds: [FIX] },
      { sha: "b2", message: "second", authorLogin: null, pushedAt, seq: 2, fixIds: [] },
    ];
    assert.equal(await recordRepoCommits(row.id, commits, db), 2);
    assert.equal(await recordRepoCommits(row.id, commits, db), 0);
    await markCommitsDeployed(row.id, ["a1"], new Date("2026-11-17T11:00:00Z"), [SHIPMENT], db);

    const stored = await listRepoCommits(row.id, db);
    assert.deepEqual(
      stored.map((c) => c.sha),
      ["a1", "b2"],
    );
    assert.equal(stored[0].messageHead.length, MESSAGE_HEAD_MAX);
    assert.deepEqual(stored[0].fixIds, [FIX]);
    assert.deepEqual(stored[0].shipmentIds, [SHIPMENT]);
    assert.ok(stored[0].deployedAt);
    assert.equal(stored[1].deployedAt, null);
    assert.deepEqual(stored[1].shipmentIds, []);

    await unlinkRepo(P1, db);
    assert.deepEqual(await listRepoCommits(row.id, db), []);
  } finally {
    await client.close();
  }
});

test("repo_code_pointers: replaced as a whole; an unknown kind is refused", async () => {
  const { client, db } = await setup();
  try {
    const row = await linkRepo(link(P1), db);
    await replaceCodePointers(
      row.id,
      [{ kind: "tool", symbol: "search_flights", path: "src/tools.ts", line: 12 }],
      db,
    );
    await replaceCodePointers(
      row.id,
      [
        { kind: "prompt", symbol: "system", path: "src/prompt.md", line: null },
        { kind: "model", symbol: "planner", path: "src/agent.ts", line: 40 },
      ],
      db,
    );
    const pointers = await listCodePointers(row.id, db);
    assert.deepEqual(
      pointers.map((p) => [p.kind, p.symbol, p.path, p.line]),
      [
        ["model", "planner", "src/agent.ts", 40],
        ["prompt", "system", "src/prompt.md", null],
      ],
    );
    await assert.rejects(
      client.exec(
        `insert into repo_code_pointers (repo_link_id, kind, symbol, path) values ('${row.id}', 'skill', 's', 'p')`,
      ),
    );
  } finally {
    await client.close();
  }
});

test("fix_handoffs: once per project, fix and target", async () => {
  const { client, db } = await setup();
  try {
    const handoff = {
      projectId: P1,
      fixId: FIX,
      target: "github_issue",
      externalId: "1001",
      url: "https://github.com/acme/r/issues/1",
      handedOffBy: "user_roberto",
    };
    const first = await recordFixHandoff(handoff, db);
    const again = await recordFixHandoff(
      { ...handoff, externalId: "1002", url: "https://github.com/acme/r/issues/2" },
      db,
    );
    assert.equal(again.id, first.id);
    assert.equal(again.externalId, "1001");
    assert.equal((await getFixHandoff(P1, FIX, "github_issue", db))?.url, handoff.url);
    assert.equal(await getFixHandoff(P2, FIX, "github_issue", db), null);
    await client.exec(`delete from projects where id = '${P1}'`);
    assert.equal(await getFixHandoff(P1, FIX, "github_issue", db), null);
  } finally {
    await client.close();
  }
});
