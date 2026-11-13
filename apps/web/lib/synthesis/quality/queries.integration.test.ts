import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { hitCredit, scoreObservations } from "@/lib/synthesis/quality/metrics";
import { byArm, observeSelections, pickBaselineArm } from "./ground-truth";
import {
  listQualityCalibrations,
  listQualityProjects,
  loadEvaluableSelections,
  type QualityQueriesDb,
} from "./queries";

/**
 * The quality meter's reads against an in-process Postgres, seeded with the
 * shape a shadow-tested partner actually emits: one `comparison` record per
 * search, one `results` record per arm, and an `invocation` record when the
 * agent went on to run something.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const EXPERIMENT = "mcp_search_operations";
const WINDOW = {
  since: new Date("2026-09-01T00:00:00Z"),
  until: new Date("2026-09-08T00:00:00Z"),
};

let logId = 0;
function nextId(): string {
  logId += 1;
  const h = logId.toString(16).padStart(12, "0");
  return `bbbbbbbb-bbbb-4bbb-8bbb-${h}`;
}

function json(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

async function seedLog(
  client: PGlite,
  row: {
    projectId?: string;
    eventName: string;
    occurredAt: string;
    arm?: string | null;
    role?: string | null;
    selectionId?: string | null;
    experimentAttrs?: Record<string, unknown>;
    attributes?: Record<string, unknown>;
    experimentName?: string | null;
  },
): Promise<void> {
  const experimentName = row.experimentName === undefined ? EXPERIMENT : row.experimentName;
  await client.exec(
    `insert into otel_logs
       (id, project_id, occurred_at, event_name, severity_number,
        experiment_name, experiment_arm, experiment_role, experiment_selection_id,
        experiment_attrs, attributes)
     values (
       '${nextId()}', '${row.projectId ?? PROJECT}', '${row.occurredAt}',
       '${row.eventName}', 9,
       ${experimentName === null ? "null" : `'${experimentName}'`},
       ${row.arm == null ? "null" : `'${row.arm}'`},
       ${row.role == null ? "null" : `'${row.role}'`},
       ${row.selectionId == null ? "null" : `'${row.selectionId}'`},
       ${json(row.experimentAttrs ?? {})}, ${json(row.attributes ?? {})}
     );`,
  );
}

interface SeedSearch {
  id: string;
  at: string;
  query: string;
  /** Ranked ids the shadow arm (ratel) returned. */
  ratel: string[];
  /** Ranked ids the serving arm (legacy) returned. */
  legacy: string[];
  ratelScores?: number[];
  /** The tool the agent went on to run, when it ran one. */
  invoked?: string;
  invokedKey?: string;
  attributed?: boolean;
  /** 0-based wire rank, -1 for "the serving arm never returned it". */
  invokedWireRank?: number;
  effectiveArm?: string;
  servedDurationMs?: number;
  shadowDurationMs?: number;
  k?: number;
}

async function seedSearch(client: PGlite, search: SeedSearch): Promise<void> {
  await seedLog(client, {
    eventName: "ratel.experiment.comparison",
    occurredAt: search.at,
    arm: "ratel",
    role: "shadow",
    selectionId: search.id,
    experimentAttrs: {
      "ratel.experiment.query": search.query,
      "ratel.experiment.served.arm": "legacy",
      "ratel.experiment.shadow.arm": "ratel",
      "ratel.experiment.served.outcome": "ok",
      "ratel.experiment.shadow.outcome": "ok",
      "ratel.experiment.served.duration_ms": search.servedDurationMs ?? 1500,
      "ratel.experiment.shadow.duration_ms": search.shadowDurationMs ?? 44,
      "ratel.experiment.agreement.k": search.k ?? 5,
    },
  });
  // Results records land a beat after the comparison, and deliberately outside
  // the queried window here so the test proves they are not window-bounded.
  for (const [arm, ids, scores] of [
    ["ratel", search.ratel, search.ratelScores],
    ["legacy", search.legacy, undefined],
  ] as const) {
    await seedLog(client, {
      eventName: "ratel.experiment.results",
      occurredAt: "2026-09-09T00:00:00Z",
      arm,
      role: arm === "legacy" ? "serving" : "shadow",
      selectionId: search.id,
      experimentAttrs: {
        "ratel.experiment.result_ids": ids,
        ...(scores ? { "ratel.experiment.result_scores": scores } : {}),
      },
    });
  }
  if (search.invoked) {
    await seedLog(client, {
      eventName: "ratel.experiment.invocation",
      occurredAt: "2026-09-09T00:00:00Z",
      arm: "legacy",
      role: "serving",
      selectionId: search.id,
      experimentAttrs: {
        "ratel.experiment.invocation.attributed": search.attributed ?? true,
        [search.invokedKey ?? "ratel.experiment.invocation.tool_id"]: search.invoked,
      },
    });
  }
  if (search.invokedWireRank !== undefined) {
    await seedLog(client, {
      eventName: "ratel.experiment.invocation",
      occurredAt: "2026-09-09T00:00:00Z",
      selectionId: search.id,
      experimentAttrs: {
        "ratel.experiment.invocation.attributed": true,
        "ratel.experiment.invocation.rank": search.invokedWireRank,
        "ratel.experiment.effective_arm": search.effectiveArm ?? "legacy",
      },
    });
  }
}

async function setup(): Promise<{ client: PGlite; db: QualityQueriesDb }> {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug)
       values ('${PROJECT}', '${ORG}', 'Acme MCP', 'acme-mcp'),
              ('${OTHER_PROJECT}', '${ORG}', 'Other', 'other');`,
  );
  return { client, db: drizzle(client, { schema }) as unknown as QualityQueriesDb };
}

test("loads both arms' rankings and the tool the agent ran", async () => {
  const { client, db } = await setup();
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-04T10:00:00Z",
    query: "unlink tasks",
    ratel: ["unlink_pr_from_task", "delete_task_relationship", "remove_tag_from_task"],
    legacy: ["delete_task_relationship"],
    invoked: "delete_task_relationship",
  });

  const { selections, diagnostics } = await loadEvaluableSelections(
    PROJECT,
    EXPERIMENT,
    WINDOW,
    db,
  );

  assert.equal(selections.length, 1);
  assert.equal(diagnostics.invocationCount, 1);
  assert.equal(diagnostics.rankedSelectionCount, 1);
  assert.equal(diagnostics.invokedToolKey, "ratel.experiment.invocation.tool_id");
  assert.equal(selections[0].query, "unlink tasks");
  assert.equal(selections[0].invokedToolId, "delete_task_relationship");

  const ratel = selections[0].arms.find((arm) => arm.arm === "ratel")!;
  const legacy = selections[0].arms.find((arm) => arm.arm === "legacy")!;
  assert.equal(ratel.role, "shadow");
  assert.equal(legacy.role, "serving");
  assert.equal(ratel.resultIds.length, 3);
  assert.equal(ratel.durationMs, 44);
  assert.equal(legacy.durationMs, 1500);
  assert.equal(ratel.requestedK, 5);
});

test("scores containment and quality end to end for both arms", async () => {
  const { client, db } = await setup();
  // Three searches the agent followed up on. Ratel contains the tool every time
  // but ranks it 2nd, 1st and 3rd; legacy leads with it every time.
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-04T10:00:00Z",
    query: "unlink tasks",
    ratel: ["unlink_pr_from_task", "delete_task_relationship"],
    legacy: ["delete_task_relationship"],
    invoked: "delete_task_relationship",
  });
  await seedSearch(client, {
    id: "sel-2",
    at: "2026-09-04T11:00:00Z",
    query: "update task status",
    ratel: ["update_task_status", "list_tasks_by_status"],
    legacy: ["update_task_status"],
    invoked: "update_task_status",
  });
  await seedSearch(client, {
    id: "sel-3",
    at: "2026-09-04T12:00:00Z",
    query: "list tasks in a project",
    ratel: ["count_tasks", "list_tasks_by_status", "filter_tasks"],
    legacy: ["filter_tasks", "count_tasks"],
    invoked: "filter_tasks",
  });

  const { selections } = await loadEvaluableSelections(PROJECT, EXPERIMENT, WINDOW, db);
  const baseline = pickBaselineArm(selections);
  assert.equal(baseline, "legacy");

  const scored = byArm(observeSelections(selections, "revealed", baseline!));
  const ratel = scoreObservations(scored.get("ratel")!);
  const legacy = scoreObservations(scored.get("legacy")!);

  assert.equal(ratel.n, 3);
  assert.equal(ratel.contained, 3);
  assert.equal(ratel.containment, 1);
  assert.deepEqual(ratel.rankHistogram, { "1": 1, "2": 1, "3": 1 });
  // (1 + 0.8154… + 0.75) / 3
  assert.ok(Math.abs(ratel.quality! - (hitCredit(1) + hitCredit(2) + hitCredit(3)) / 3) < 1e-9);

  assert.equal(legacy.n, 3);
  assert.equal(legacy.quality, 1);
  // Both arms always contained it, so only quality tells them apart.
  assert.equal(ratel.containment, legacy.containment);
  assert.ok(ratel.quality! < legacy.quality!);
});

test("counts a search the arm missed as a scored zero, not a dropped row", async () => {
  const { client, db } = await setup();
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-04T10:00:00Z",
    query: "search all existing tasks",
    ratel: ["search_tasks_by_time", "list_stale_tasks"],
    legacy: ["search_tasks"],
    invoked: "search_tasks",
  });

  const { selections } = await loadEvaluableSelections(PROJECT, EXPERIMENT, WINDOW, db);
  const scored = byArm(observeSelections(selections, "revealed", "legacy"));
  const ratel = scoreObservations(scored.get("ratel")!);

  assert.equal(ratel.n, 1);
  assert.equal(ratel.contained, 0);
  assert.equal(ratel.containment, 0);
  assert.equal(ratel.quality, 0);
});

test("searches with no attributed invocation leave the revealed tier empty", async () => {
  const { client, db } = await setup();
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-04T10:00:00Z",
    query: "no follow up",
    ratel: ["a", "b"],
    legacy: ["b"],
  });
  await seedSearch(client, {
    id: "sel-2",
    at: "2026-09-04T11:00:00Z",
    query: "unattributed follow up",
    ratel: ["a", "b"],
    legacy: ["b"],
    invoked: "b",
    attributed: false,
  });

  const { selections, diagnostics } = await loadEvaluableSelections(
    PROJECT,
    EXPERIMENT,
    WINDOW,
    db,
  );

  assert.equal(diagnostics.selectionCount, 2);
  assert.equal(diagnostics.invocationCount, 0);
  assert.equal(observeSelections(selections, "revealed", "legacy").length, 0);
  // The reference tier still has every one of them.
  assert.equal(observeSelections(selections, "reference", "legacy").length, 2);
});

async function seedLabel(
  client: PGlite,
  label: { queryKey: string; entryId: string; source: "invoked" | "judge" | "unclear" },
): Promise<void> {
  await client.exec(
    `insert into match_quality_labels
       (project_id, query_key, query, entry_id, source, observed_at)
     values ('${PROJECT}', '${label.queryKey}', '${label.queryKey}',
       '${label.entryId}', '${label.source}', '2026-09-04T00:00:00Z');`,
  );
}

test("attaches the answer key by normalized query, and never guesses", async () => {
  const { client, db } = await setup();
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-04T10:00:00Z",
    query: "  Unlink   Tasks ",
    ratel: ["delete_task_relationship"],
    legacy: ["delete_task"],
  });
  await seedSearch(client, {
    id: "sel-2",
    at: "2026-09-04T11:00:00Z",
    query: "something vague",
    ratel: ["a"],
    legacy: ["b"],
  });
  await seedSearch(client, {
    id: "sel-3",
    at: "2026-09-04T12:00:00Z",
    query: "nobody read this",
    ratel: ["a"],
    legacy: ["b"],
  });
  await seedLabel(client, {
    queryKey: "unlink tasks",
    entryId: "delete_task_relationship",
    source: "judge",
  });
  await seedLabel(client, { queryKey: "something vague", entryId: "", source: "unclear" });

  const { selections } = await loadEvaluableSelections(PROJECT, EXPERIMENT, WINDOW, db);
  const byId = new Map(selections.map((selection) => [selection.selectionId, selection]));

  assert.equal(byId.get("sel-1")!.judgedToolId, "delete_task_relationship");
  assert.equal(byId.get("sel-2")!.judgedToolId ?? null, null);
  assert.equal(byId.get("sel-2")!.unclear, true);
  assert.equal(byId.get("sel-3")!.judgedToolId ?? null, null);
  assert.ok(!byId.get("sel-3")!.unclear);

  // Only the answered search is scored, and the baseline is scored on it too.
  const grouped = byArm(observeSelections(selections, "judged", "legacy"));
  assert.deepEqual(
    grouped.get("legacy")!.map((observation) => observation.rank),
    [null],
  );
  assert.deepEqual(
    grouped.get("ratel")!.map((observation) => observation.rank),
    [1],
  );
});

test("finds the invoked tool under an alternative vocabulary key", async () => {
  const { client, db } = await setup();
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-04T10:00:00Z",
    query: "alt key",
    ratel: ["a", "b"],
    legacy: ["b"],
    invoked: "b",
    invokedKey: "gen_ai.tool.name",
  });

  const { selections, diagnostics } = await loadEvaluableSelections(
    PROJECT,
    EXPERIMENT,
    WINDOW,
    db,
  );
  assert.equal(diagnostics.invokedToolKey, "gen_ai.tool.name");
  assert.equal(selections[0].invokedToolId, "b");
});

test("an arm named on the comparison but missing its results still gets scored", async () => {
  const { client, db } = await setup();
  await seedLog(client, {
    eventName: "ratel.experiment.comparison",
    occurredAt: "2026-09-04T10:00:00Z",
    arm: "ratel",
    role: "shadow",
    selectionId: "sel-1",
    experimentAttrs: {
      "ratel.experiment.served.arm": "legacy",
      "ratel.experiment.shadow.arm": "ratel",
    },
  });
  await seedLog(client, {
    eventName: "ratel.experiment.results",
    occurredAt: "2026-09-04T10:00:01Z",
    arm: "legacy",
    role: "serving",
    selectionId: "sel-1",
    experimentAttrs: { "ratel.experiment.result_ids": ["b"] },
  });
  await seedLog(client, {
    eventName: "ratel.experiment.invocation",
    occurredAt: "2026-09-04T10:00:02Z",
    selectionId: "sel-1",
    experimentAttrs: {
      "ratel.experiment.invocation.attributed": true,
      "ratel.experiment.invocation.tool_id": "b",
    },
  });

  const { selections } = await loadEvaluableSelections(PROJECT, EXPERIMENT, WINDOW, db);
  const scored = byArm(observeSelections(selections, "revealed", "legacy"));

  // Both arms are scored over the same one search: ratel simply scores zero.
  assert.equal(scoreObservations(scored.get("ratel")!).n, 1);
  assert.equal(scoreObservations(scored.get("ratel")!).quality, 0);
  assert.equal(scoreObservations(scored.get("legacy")!).quality, 1);
});

test("ignores other projects, other calibrations and other windows", async () => {
  const { client, db } = await setup();
  await seedSearch(client, {
    id: "sel-in",
    at: "2026-09-04T10:00:00Z",
    query: "in window",
    ratel: ["a"],
    legacy: ["a"],
  });
  await seedSearch(client, {
    id: "sel-early",
    at: "2026-08-04T10:00:00Z",
    query: "before window",
    ratel: ["a"],
    legacy: ["a"],
  });
  await seedLog(client, {
    projectId: OTHER_PROJECT,
    eventName: "ratel.experiment.comparison",
    occurredAt: "2026-09-04T10:00:00Z",
    selectionId: "sel-other-project",
    experimentAttrs: { "ratel.experiment.served.arm": "legacy" },
  });
  await seedLog(client, {
    eventName: "ratel.experiment.comparison",
    occurredAt: "2026-09-04T10:00:00Z",
    experimentName: "some_other_calibration",
    selectionId: "sel-other-calibration",
    experimentAttrs: { "ratel.experiment.served.arm": "legacy" },
  });

  const { selections } = await loadEvaluableSelections(PROJECT, EXPERIMENT, WINDOW, db);
  assert.deepEqual(
    selections.map((selection) => selection.selectionId),
    ["sel-in"],
  );
});

test("caps the population at the limit, keeping the newest searches", async () => {
  const { client, db } = await setup();
  for (let i = 0; i < 5; i++) {
    await seedSearch(client, {
      id: `sel-${i}`,
      at: `2026-09-0${i + 1}T10:00:00Z`,
      query: `q${i}`,
      ratel: ["a"],
      legacy: ["a"],
    });
  }

  const { selections, diagnostics } = await loadEvaluableSelections(
    PROJECT,
    EXPERIMENT,
    WINDOW,
    db,
    2,
  );

  assert.equal(diagnostics.truncated, true);
  assert.equal(selections.length, 2);
  // Oldest-first within the kept slice, but the slice itself is the newest.
  assert.deepEqual(
    selections.map((selection) => selection.selectionId),
    ["sel-3", "sel-4"],
  );
  // The window held five searches and we scored two. Reporting the cap as the
  // comparison count would understate a busy partner's traffic on their own
  // report, so the count is the window's and `selectionCount` is the sample.
  assert.equal(diagnostics.comparisonCount, 5);
  assert.equal(diagnostics.selectionCount, 2);
});

test("an uncapped window counts its comparisons without a second scan", async () => {
  const { client, db } = await setup();
  for (let i = 0; i < 3; i++) {
    await seedSearch(client, {
      id: `sel-${i}`,
      at: `2026-09-0${i + 1}T10:00:00Z`,
      query: `q${i}`,
      ratel: ["a"],
      legacy: ["a"],
    });
  }

  const { diagnostics } = await loadEvaluableSelections(PROJECT, EXPERIMENT, WINDOW, db, 10);

  assert.equal(diagnostics.truncated, false);
  assert.equal(diagnostics.comparisonCount, 3);
});

test("lists the calibrations and the projects that carry comparisons", async () => {
  const { client, db } = await setup();
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-04T10:00:00Z",
    query: "a",
    ratel: ["a"],
    legacy: ["a"],
  });
  await seedSearch(client, {
    id: "sel-2",
    at: "2026-09-04T11:00:00Z",
    query: "b",
    ratel: ["a"],
    legacy: ["a"],
  });
  await seedLog(client, {
    eventName: "ratel.experiment.comparison",
    occurredAt: "2026-09-05T10:00:00Z",
    experimentName: "quieter_calibration",
    selectionId: "sel-3",
    experimentAttrs: {},
  });

  const calibrations = await listQualityCalibrations(PROJECT, WINDOW, db);
  assert.deepEqual(calibrations, [
    { experimentName: EXPERIMENT, comparisonCount: 2 },
    { experimentName: "quieter_calibration", comparisonCount: 1 },
  ]);

  const projects = await listQualityProjects(WINDOW, db);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].projectId, PROJECT);
  assert.equal(projects[0].calibrationCount, 2);
  assert.equal(projects[0].comparisonCount, 3);
});

test("falls back to the recorded rank when telemetry names no tool", async () => {
  // The shape today's SDK actually emits: attributed, rank, effective_arm, and
  // nothing that identifies the tool. Verified against a `make seed` database.
  const { client, db } = await setup();
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-04T10:00:00Z",
    query: "update task status",
    ratel: ["update_task_status", "update_task"],
    legacy: ["update_task", "update_task_status"],
    invokedWireRank: 1,
  });
  await seedSearch(client, {
    id: "sel-2",
    at: "2026-09-04T11:00:00Z",
    query: "unlink tasks",
    ratel: ["unlink_pr_from_task"],
    legacy: ["delete_task_relationship"],
    invokedWireRank: -1,
  });

  const { selections, diagnostics } = await loadEvaluableSelections(
    PROJECT,
    EXPERIMENT,
    WINDOW,
    db,
  );

  assert.equal(diagnostics.attributionMode, "recorded-rank");
  assert.equal(diagnostics.invocationCount, 0);
  assert.equal(diagnostics.recordedRankCount, 2);

  const scored = byArm(observeSelections(selections, "revealed", "legacy", "recorded-rank"));
  // Only the serving arm is scorable: nothing says which tool to look for in
  // the shadow arm's list.
  assert.deepEqual([...scored.keys()], ["legacy"]);

  const legacy = scoreObservations(scored.get("legacy")!);
  assert.equal(legacy.n, 2);
  assert.equal(legacy.contained, 1);
  assert.equal(legacy.containment, 0.5);
  // Wire rank 1 is 1-based rank 2, worth 0.82 of a hit at the top.
  assert.ok(Math.abs(legacy.quality! - hitCredit(2) / 2) < 1e-9);
});

test("a tool id anywhere in the window wins over the recorded rank", async () => {
  const { client, db } = await setup();
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-04T10:00:00Z",
    query: "unlink tasks",
    ratel: ["unlink_pr_from_task", "delete_task_relationship"],
    legacy: ["delete_task_relationship"],
    invoked: "delete_task_relationship",
    invokedWireRank: 0,
  });

  const { diagnostics } = await loadEvaluableSelections(PROJECT, EXPERIMENT, WINDOW, db);

  // Both are present, and the identity wins because it can score every arm.
  assert.equal(diagnostics.attributionMode, "tool-id");
  assert.equal(diagnostics.invocationCount, 1);
  assert.equal(diagnostics.recordedRankCount, 1);
});
