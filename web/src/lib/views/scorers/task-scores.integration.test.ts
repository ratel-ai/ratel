import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { createScorer, insertTraceScores } from "./store";
import { loadTaskScorers } from "./task-scores";
import { checkDraft, judgeDraft } from "./test-support";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-20T12:00:00Z");

test("a task's live scores are the stored results of the scorers scoped to it", async () => {
  const client = await createMigratedPGlite();
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
      insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    `);
    const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
    const filter = { taskId: "task-a" };
    const check = await createScorer(PROJECT, checkDraft({ name: "Fast", filter }), "u", db);
    const judge = await createScorer(
      PROJECT,
      judgeDraft({ name: "Helpful", filter, config: { prompt: "Good?", output: "numeric" } }),
      "u",
      db,
    );
    const other = await createScorer(
      PROJECT,
      checkDraft({ filter: { taskId: "task-b" } }),
      "u",
      db,
    );
    const every = await createScorer(PROJECT, checkDraft(), "u", db);
    const score = (
      scorerId: string,
      traceId: string,
      day: string,
      passed: boolean | null,
      value: number,
    ) => ({
      scorerId,
      projectId: PROJECT,
      traceId,
      traceStartedAt: new Date(`${day}T10:00:00Z`),
      value,
      passed,
      confidence: null,
    });
    await insertTraceScores(
      [
        score(check, "old", "2026-11-01", true, 1),
        score(check, "a", "2026-11-18", true, 1),
        score(check, "b", "2026-11-20", true, 1),
        score(check, "c", "2026-11-20", false, 0),
        score(judge, "a", "2026-11-20", null, 4),
        score(other, "d", "2026-11-20", false, 0),
        score(every, "a", "2026-11-20", false, 0),
      ],
      db,
    );

    const [first, second, ...rest] = await loadTaskScorers(PROJECT, "task-a", NOW, db);
    assert.deepEqual(rest, []);
    assert.deepEqual([first?.id, first?.name, first?.verdict], [check, "Fast", true]);
    assert.equal(first?.week?.scored, 3);
    assert.equal(first?.trend.length, 14);
    assert.deepEqual(
      first?.trend.filter((day) => day.scored > 0),
      [
        { day: "2026-11-18", scored: 1, value: 1 },
        { day: "2026-11-20", scored: 2, value: 0.5 },
      ],
    );
    assert.deepEqual([second?.id, second?.verdict], [judge, false]);
    assert.deepEqual(second?.trend.at(-1), { day: "2026-11-20", scored: 1, value: 4 });
    assert.deepEqual(await loadTaskScorers(PROJECT, "task-c", NOW, db), []);
  } finally {
    await client.close();
  }
});
