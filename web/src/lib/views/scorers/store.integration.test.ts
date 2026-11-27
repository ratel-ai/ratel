import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  createScorer,
  deleteScorer,
  getScorer,
  insertTraceScores,
  latestScores,
  listScorers,
  scorerSummaries,
  scorerTrend,
  scoresOfTrace,
  setScorerEnabled,
  updateScorer,
} from "./store";
import { checkDraft, judgeDraft } from "./test-support";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";

test("a scorer is created, updated, disabled and deleted inside its project", async () => {
  const { client, db } = await setup();
  try {
    const id = await createScorer(PROJECT, checkDraft({ filter: { models: ["a"] } }), "u1", db);
    const created = await getScorer(PROJECT, id, db);
    assert.deepEqual(created?.config, { path: "duration_ms", op: "lte", value: 1000 });
    assert.deepEqual(created?.filter, { models: ["a"] });
    assert.equal(await getScorer(OTHER_PROJECT, id, db), null);

    assert.equal(
      await updateScorer(PROJECT, id, checkDraft({ name: "Slow", sampleRate: 50 }), "u2", db),
      true,
    );
    const updated = await getScorer(PROJECT, id, db);
    assert.equal(updated?.name, "Slow");
    assert.equal(updated?.sampleRate, 50);
    assert.equal(await updateScorer(PROJECT, id, judgeDraft(), "u2", db), false, "kind is kept");

    assert.equal(await setScorerEnabled(OTHER_PROJECT, id, false, "u2", db), false);
    assert.equal(await deleteScorer(OTHER_PROJECT, id, db), false);
    assert.equal(await setScorerEnabled(PROJECT, id, false, "u2", db), true);
    assert.equal((await listScorers(PROJECT, db))[0]?.enabled, false);

    await insertTraceScores([score(id, "t1", true)], db);
    assert.equal(await deleteScorer(PROJECT, id, db), true);
    assert.deepEqual(await listScorers(PROJECT, db), []);
    assert.deepEqual(await scoresOfTrace(PROJECT, "t1", db), [], "results go with the scorer");
  } finally {
    await client.close();
  }
});

test("the cursor moves to now only when a disabled scorer is enabled", async () => {
  const { client, db } = await setup();
  const cursor = async () =>
    (await client.query<{ at: string }>("select cursor_at::text as at from trace_scorers")).rows[0]
      ?.at ?? "";
  try {
    const id = await createScorer(PROJECT, checkDraft(), "u1", db);
    await client.exec("update trace_scorers set cursor_at = '2026-01-01T00:00:00Z'");
    await setScorerEnabled(PROJECT, id, true, "u1", db);
    await updateScorer(PROJECT, id, checkDraft({ name: "B" }), "u1", db);
    await setScorerEnabled(PROJECT, id, false, "u1", db);
    assert.match(await cursor(), /^2026-01-01/);
    await updateScorer(PROJECT, id, checkDraft({ enabled: true }), "u1", db);
    assert.doesNotMatch(await cursor(), /^2026-01-01/);
  } finally {
    await client.close();
  }
});

test("a result inserted twice is one row, the first one", async () => {
  const { client, db } = await setup();
  try {
    const id = await createScorer(PROJECT, checkDraft(), "u1", db);
    assert.equal(await insertTraceScores([score(id, "t1", true)], db), 1);
    assert.equal(await insertTraceScores([score(id, "t1", false), score(id, "t2", false)], db), 1);
    const rows = await latestScores(PROJECT, id, 10, db);
    assert.deepEqual(
      rows.map(({ traceId, passed }) => [traceId, passed]),
      [
        ["t2", false],
        ["t1", true],
      ],
    );
  } finally {
    await client.close();
  }
});

test("summaries and the trend give a pass rate to a verdict and an average to a number", async () => {
  const { client, db } = await setup();
  try {
    const check = await createScorer(PROJECT, checkDraft(), "u1", db);
    const judge = await createScorer(PROJECT, judgeDraft(), "u1", db);
    await insertTraceScores(
      [
        score(check, "t1", true),
        score(check, "t2", false),
        score(check, "old", false, new Date("2026-10-01T00:00:00Z")),
        { ...score(judge, "t1", true), value: 4, passed: null, confidence: 0.9 },
        { ...score(judge, "t2", true), value: 5, passed: null, confidence: 0.7 },
      ],
      db,
    );
    const since = new Date("2026-11-19T00:00:00Z");
    const summaries = await scorerSummaries(PROJECT, since, db);
    assert.deepEqual(summaries.get(check), { scored: 2, passRate: 0.5, average: 0.5 });
    assert.deepEqual(summaries.get(judge), { scored: 2, passRate: null, average: 4.5 });
    assert.deepEqual(await scorerTrend(PROJECT, check, since, db), [
      { day: "2026-11-20", scored: 2, passRate: 0.5, average: 0.5 },
    ]);
    assert.equal((await scorerSummaries(OTHER_PROJECT, since, db)).size, 0);
    assert.deepEqual(
      (await scoresOfTrace(PROJECT, "t1", db)).map((row) => [row.scorerName, row.value]),
      [
        ["Fast enough", 1],
        ["Polite", 4],
      ],
    );
  } finally {
    await client.close();
  }
});

function score(
  scorerId: string,
  traceId: string,
  passed: boolean,
  traceStartedAt = new Date("2026-11-20T10:00:00Z"),
) {
  return {
    scorerId,
    projectId: PROJECT,
    traceId,
    traceStartedAt,
    value: passed ? 1 : 0,
    passed,
    confidence: null,
  };
}

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'),
      ('${OTHER_PROJECT}', '${ORG}', 'Other', 'other');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof getDb> };
}
