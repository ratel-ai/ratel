import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { MAX_SCORERS } from "./config";
import { loadScorerPicker, scorerIdsOf, scorerNames } from "./picker";
import { createScorer } from "./store";
import { checkDraft, judgeDraft } from "./test-support";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-20T12:00:00Z");

test("the picker counts each scorer's widgets, alert rules and tasks, and the room left", async () => {
  const client = await createMigratedPGlite();
  try {
    await client.exec(`
      insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
      insert into projects (id, organization_id, name, slug) values
        ('${PROJECT}', '${ORG}', 'Agent', 'agent'), ('${OTHER}', '${ORG}', 'Other', 'other');
    `);
    const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
    const used = await createScorer(PROJECT, checkDraft({ tasks: ["t1", "t2"] }), "u1", db);
    const judge = await createScorer(PROJECT, judgeDraft({ name: "Judge" }), "u1", db);
    const idle = await createScorer(PROJECT, checkDraft({ name: "Idle" }), "u1", db);
    const metric = (id: string) => ({
      kind: "metric",
      measures: [{ measure: "scorer_pass_rate", aggregation: "rate" }],
      filters: { scorer: { id } },
    });
    const funnel = {
      kind: "funnel",
      steps: [
        { type: "scorer", scorer: { id: used } },
        { type: "scorer", scorer: { id: judge } },
      ],
    };
    await client.query(
      `insert into dashboards (project_id, name, widgets, updated_by) values
        ($1, 'One', $2, 'u1'), ($1, 'Two', $3, 'u1'), ($4, 'Elsewhere', $5, 'u1')`,
      [
        PROJECT,
        JSON.stringify([
          { id: "w1", query: metric(used) },
          { id: "w2", query: funnel },
        ]),
        JSON.stringify([{ id: "w3", query: metric(used) }]),
        OTHER,
        JSON.stringify([{ id: "w4", query: metric(idle) }]),
      ],
    );
    await client.query(
      `insert into alert_rules (project_id, name, query, operator, threshold, window_minutes, created_by, updated_by)
       values ($1, 'Low', $2, 'below', 0.5, 60, 'u1', 'u1')`,
      [PROJECT, JSON.stringify(metric(judge))],
    );
    await client.exec(
      `insert into scorer_judge_spend (project_id, day, usd) values ('${PROJECT}', '2026-11-20', 2.5)`,
    );

    const picker = await loadScorerPicker(PROJECT, NOW, db);
    assert.deepEqual(
      picker.scorers.map((scorer) => [scorer.id, scorer.usage]),
      [
        [used, { widgets: 3, alerts: 0, tasks: 2, total: 5 }],
        [judge, { widgets: 1, alerts: 1, tasks: 0, total: 2 }],
        [idle, { widgets: 0, alerts: 0, tasks: 0, total: 0 }],
      ],
    );
    assert.deepEqual([picker.count, picker.limit], [3, MAX_SCORERS]);
    assert.deepEqual(picker.budget, { dailyUsd: 10, spentUsd: 2.5, leftUsd: 7.5 });
    assert.equal(picker.unread, false);
    // What only names a scorer reads no usage and no spend.
    assert.deepEqual(
      (await scorerNames(PROJECT, db)).map(({ name, verdict }) => [name, verdict]),
      [
        ["Fast enough", true],
        ["Judge", true],
        ["Idle", true],
      ],
    );
    assert.equal(picker.scorers[1]?.verdict, true);
    assert.equal(picker.scorers[0]?.summary, "Duration (ms) is at most 1000");
  } finally {
    await client.close();
  }
});

test("a scorer id is read from any `scorer` of a query, at any depth, once", () => {
  assert.deepEqual(
    [...scorerIdsOf({ a: [{ scorer: { id: "x" } }, { b: { scorer: { id: "x" } } }], scorer: "y" })],
    ["x"],
  );
  assert.deepEqual([...scorerIdsOf(null)], []);
});
