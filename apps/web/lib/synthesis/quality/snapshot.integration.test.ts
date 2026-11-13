import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { addTotals, emptyTotals, hitCredit, scoreTotals } from "@/lib/synthesis/quality/metrics";
import { recordCatalogFingerprint } from "./fingerprint";
import {
  loadFingerprintChanges,
  loadFirstFingerprintAt,
  loadQualityTrend,
  projectsForPass,
  type QualitySnapshotDb,
  refreshQualitySnapshots,
} from "./snapshot";

/**
 * The drain's quality step against a real database: the fingerprint only moves
 * when the corpus does, and a day's rollup folds back into the same score the
 * live query would have produced.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const EXPERIMENT = "mcp_search_operations";
const NOW = new Date("2026-09-06T12:00:00Z");

let logId = 0;
function nextId(): string {
  logId += 1;
  const h = logId.toString(16).padStart(12, "0");
  return `cccccccc-cccc-4ccc-8ccc-${h}`;
}

function json(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

async function seedLog(
  client: PGlite,
  row: {
    eventName: string;
    occurredAt: string;
    arm?: string | null;
    role?: string | null;
    selectionId: string;
    experimentAttrs: Record<string, unknown>;
  },
): Promise<void> {
  await client.exec(
    `insert into otel_logs
       (id, project_id, occurred_at, event_name, severity_number,
        experiment_name, experiment_arm, experiment_role,
        experiment_selection_id, experiment_attrs, attributes)
     values ('${nextId()}', '${PROJECT}', '${row.occurredAt}',
        '${row.eventName}', 9, '${EXPERIMENT}',
        ${row.arm == null ? "null" : `'${row.arm}'`},
        ${row.role == null ? "null" : `'${row.role}'`},
        '${row.selectionId}', ${json(row.experimentAttrs)}, '{}'::jsonb);`,
  );
}

async function seedSearch(
  client: PGlite,
  search: {
    id: string;
    at: string;
    ratel: string[];
    legacy: string[];
    invoked?: string;
    query?: string;
  },
): Promise<void> {
  await seedLog(client, {
    eventName: "ratel.experiment.comparison",
    occurredAt: search.at,
    arm: "ratel",
    role: "shadow",
    selectionId: search.id,
    experimentAttrs: {
      ...(search.query ? { "ratel.experiment.query": search.query } : {}),
      "ratel.experiment.served.arm": "legacy",
      "ratel.experiment.shadow.arm": "ratel",
      "ratel.experiment.served.duration_ms": 1500,
      "ratel.experiment.shadow.duration_ms": 44,
      "ratel.experiment.agreement.k": 3,
    },
  });
  for (const [arm, ids] of [
    ["ratel", search.ratel],
    ["legacy", search.legacy],
  ] as const) {
    await seedLog(client, {
      eventName: "ratel.experiment.results",
      occurredAt: search.at,
      arm,
      role: arm === "legacy" ? "serving" : "shadow",
      selectionId: search.id,
      experimentAttrs: { "ratel.experiment.result_ids": ids },
    });
  }
  if (search.invoked) {
    await seedLog(client, {
      eventName: "ratel.experiment.invocation",
      occurredAt: search.at,
      selectionId: search.id,
      experimentAttrs: {
        "ratel.experiment.invocation.attributed": true,
        "ratel.experiment.invocation.tool_id": search.invoked,
      },
    });
  }
}

async function seedCatalogEntry(
  client: PGlite,
  entry: { id: string; description: string; searchable?: string },
): Promise<void> {
  await client.exec(
    `insert into runtime_catalog_entries
       (project_id, kind, entry_id, name, description, searchable_description,
        searchable_description_overridden, content_hash)
     values ('${PROJECT}', 'tool', '${entry.id}', '${entry.id}',
        '${entry.description}', '${entry.searchable ?? entry.description}',
        false, 'hash-${entry.id}');`,
  );
}

async function setup(): Promise<{ client: PGlite; db: QualitySnapshotDb }> {
  const client = await createMigratedPGlite();
  await client.exec(
    `insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
     insert into projects (id, organization_id, name, slug)
       values ('${PROJECT}', '${ORG}', 'Acme MCP', 'acme-mcp');`,
  );
  return {
    client,
    db: drizzle(client, { schema }) as unknown as QualitySnapshotDb,
  };
}

test("a fingerprint is written once and only re-recorded when the corpus moves", async () => {
  const { client, db } = await setup();
  await seedCatalogEntry(client, {
    id: "delete_task_relationship",
    description: "removes an edge",
  });

  const first = await recordCatalogFingerprint(PROJECT, db, NOW);
  assert.equal(first.changed, true);

  // Re-recording an unchanged corpus is not a change.
  const later = new Date("2026-09-06T13:00:00Z");
  const second = await recordCatalogFingerprint(PROJECT, db, later);
  assert.equal(second.changed, false);
  assert.equal(second.inventory.fingerprint, first.inventory.fingerprint);

  const rows = await client.query<{
    fingerprint: string;
    first_seen_at: Date;
    last_seen_at: Date;
  }>("select fingerprint, first_seen_at, last_seen_at from catalog_fingerprints");
  assert.equal(rows.rows.length, 1);
  // first_seen_at is where the trend draws its change line, so it must not move.
  assert.equal(new Date(rows.rows[0].first_seen_at).toISOString(), NOW.toISOString());
  assert.equal(new Date(rows.rows[0].last_seen_at).toISOString(), later.toISOString());
});

test("an override changes the fingerprint and adds a second row", async () => {
  const { client, db } = await setup();
  await seedCatalogEntry(client, {
    id: "delete_task_relationship",
    description: "removes an edge",
  });
  const before = await recordCatalogFingerprint(PROJECT, db, NOW);

  await client.exec(
    `update runtime_catalog_entries
       set searchable_description_override = 'unlink tasks'
     where project_id = '${PROJECT}' and entry_id = 'delete_task_relationship';`,
  );
  const after = await recordCatalogFingerprint(PROJECT, db, new Date("2026-09-06T14:00:00Z"));

  assert.equal(after.changed, true);
  assert.notEqual(after.inventory.fingerprint, before.inventory.fingerprint);
  assert.equal(after.inventory.overriddenCount, 1);

  const changes = await loadFingerprintChanges(
    PROJECT,
    { since: new Date("2026-09-01T00:00:00Z"), until: NOW },
    db,
  );
  assert.equal(changes.length, 2);
});

test("the rollup stores one row per day, arm and tier", async () => {
  const { client, db } = await setup();
  await seedCatalogEntry(client, { id: "filter_tasks", description: "filters" });
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-05T10:00:00Z",
    ratel: ["count_tasks", "filter_tasks"],
    legacy: ["filter_tasks"],
    invoked: "filter_tasks",
  });
  await seedSearch(client, {
    id: "sel-2",
    at: "2026-09-06T10:00:00Z",
    ratel: ["filter_tasks"],
    legacy: ["filter_tasks"],
    invoked: "filter_tasks",
  });

  const result = await refreshQualitySnapshots({ db, now: NOW, force: true });
  assert.equal(result.skipped, false);
  assert.equal(result.projectsScanned, 1);
  assert.equal(result.calibrationsRolledUp, 1);

  const trend = await loadQualityTrend(
    PROJECT,
    EXPERIMENT,
    { since: new Date("2026-09-01T00:00:00Z"), until: NOW },
    db,
  );

  // Two days, revealed only. Neither search has an answer-key verdict, so the
  // judged tier writes nothing rather than scoring against legacy's first result.
  const keys = trend.map((row) => `${row.day.toISOString().slice(0, 10)}/${row.tier}/${row.arm}`);
  assert.deepEqual(keys.slice().sort(), [
    "2026-09-05/revealed/legacy",
    "2026-09-05/revealed/ratel",
    "2026-09-06/revealed/legacy",
    "2026-09-06/revealed/ratel",
  ]);
});

test("the rollup stores answer-key rows for every arm, the baseline included", async () => {
  const { client, db } = await setup();
  await seedCatalogEntry(client, { id: "filter_tasks", description: "filters" });
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-05T10:00:00Z",
    query: "Filter my tasks",
    ratel: ["filter_tasks"],
    legacy: ["count_tasks"],
  });
  await client.exec(
    `insert into match_quality_labels
       (project_id, query_key, query, entry_id, source, observed_at)
     values ('${PROJECT}', 'filter my tasks', 'Filter my tasks', 'filter_tasks',
       'judge', '2026-09-05T00:00:00Z');`,
  );

  await refreshQualitySnapshots({ db, now: NOW, force: true });
  const trend = await loadQualityTrend(
    PROJECT,
    EXPERIMENT,
    { since: new Date("2026-09-01T00:00:00Z"), until: NOW },
    db,
  );

  const judged = trend
    .filter((row) => row.tier === "judged")
    .map((row) => `${row.arm}:${row.contained}/${row.n}`)
    .sort();
  assert.deepEqual(judged, ["legacy:0/1", "ratel:1/1"]);
  assert.equal(trend.filter((row) => row.tier === "revealed").length, 0);
});

test("summing the stored days reproduces the score of the whole window", async () => {
  const { client, db } = await setup();
  await seedCatalogEntry(client, { id: "filter_tasks", description: "filters" });
  // Ranked 2nd on one day and 1st on the other.
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-05T10:00:00Z",
    ratel: ["count_tasks", "filter_tasks"],
    legacy: ["filter_tasks"],
    invoked: "filter_tasks",
  });
  await seedSearch(client, {
    id: "sel-2",
    at: "2026-09-06T10:00:00Z",
    ratel: ["filter_tasks"],
    legacy: ["filter_tasks"],
    invoked: "filter_tasks",
  });

  await refreshQualitySnapshots({ db, now: NOW, force: true });
  const trend = await loadQualityTrend(
    PROJECT,
    EXPERIMENT,
    { since: new Date("2026-09-01T00:00:00Z"), until: NOW },
    db,
  );

  const ratel = trend.filter((row) => row.arm === "ratel" && row.tier === "revealed");
  const folded = ratel.reduce(
    (totals, row) =>
      addTotals(totals, {
        n: row.n,
        contained: row.contained,
        creditSum: row.creditSum,
        reciprocalSum: row.reciprocalSum,
        rankHistogram: {},
      }),
    emptyTotals(),
  );
  const score = scoreTotals(folded);

  assert.equal(score.n, 2);
  assert.equal(score.contained, 2);
  assert.equal(score.containment, 1);
  // Ranks 1 and 2: (1 + 0.8154…) / 2.
  assert.ok(Math.abs(score.quality! - (1 + hitCredit(2)) / 2) < 1e-9);
});

test("a rerun replaces a day rather than accumulating onto it", async () => {
  const { client, db } = await setup();
  await seedCatalogEntry(client, { id: "filter_tasks", description: "filters" });
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-06T10:00:00Z",
    ratel: ["filter_tasks"],
    legacy: ["filter_tasks"],
    invoked: "filter_tasks",
  });

  await refreshQualitySnapshots({ db, now: NOW, force: true });
  await refreshQualitySnapshots({ db, now: NOW, force: true });

  const trend = await loadQualityTrend(
    PROJECT,
    EXPERIMENT,
    { since: new Date("2026-09-01T00:00:00Z"), until: NOW },
    db,
  );
  const ratel = trend.find((row) => row.arm === "ratel" && row.tier === "revealed")!;
  assert.equal(ratel.n, 1);
});

test("the pass runs once a day, not once a tick", async () => {
  const { client, db } = await setup();
  await seedCatalogEntry(client, { id: "filter_tasks", description: "filters" });
  await seedSearch(client, {
    id: "sel-1",
    at: "2026-09-06T10:00:00Z",
    ratel: ["filter_tasks"],
    legacy: ["filter_tasks"],
    invoked: "filter_tasks",
  });

  const first = await refreshQualitySnapshots({ db, now: NOW });
  assert.equal(first.skipped, false);

  // The drain ticks every minute and this step declines every one of them: the
  // console reads live, so these rows are an archive rather than a read path.
  for (const minutes of [1, 60, 60 * 12]) {
    const soon = await refreshQualitySnapshots({
      db,
      now: new Date(NOW.getTime() + minutes * 60_000),
    });
    assert.equal(soon.skipped, true, `should still be throttled after ${minutes}m`);
  }

  const tomorrow = await refreshQualitySnapshots({
    db,
    now: new Date(NOW.getTime() + 25 * 60 * 60_000),
  });
  assert.equal(tomorrow.skipped, false);
});

test("a project with comparisons but no rankings writes no rows", async () => {
  const { client, db } = await setup();
  await seedLog(client, {
    eventName: "ratel.experiment.comparison",
    occurredAt: "2026-09-06T10:00:00Z",
    arm: "ratel",
    role: "shadow",
    selectionId: "sel-1",
    experimentAttrs: {
      "ratel.experiment.served.arm": "legacy",
      "ratel.experiment.shadow.arm": "ratel",
    },
  });

  const result = await refreshQualitySnapshots({ db, now: NOW, force: true });
  // The calibration is visited, but with no ranked list and no invocation there
  // is nothing to score, and no answer key to score against either.
  assert.equal(result.daysWritten, 0);
});

test("the per-pass cap is a rotation, so no project is starved", () => {
  const projects = [
    // Ordered by traffic, the way listQualityProjects returns them.
    { projectId: "busiest" },
    { projectId: "busy" },
    { projectId: "quiet" },
  ];
  const lastRollup = new Map([
    ["busiest", new Date("2026-09-06T00:00:00Z")],
    ["busy", new Date("2026-09-04T00:00:00Z")],
  ]);

  // A project that has never been rolled up goes first, then the stalest.
  // Ordering by traffic and cutting would have left "quiet" with no rows ever.
  assert.deepEqual(
    projectsForPass(projects, lastRollup, 2).map((project) => project.projectId),
    ["quiet", "busy"],
  );
});

test("the pass keeps the traffic order between projects rolled up together", () => {
  const projects = [{ projectId: "busiest" }, { projectId: "busy" }];
  const same = new Date("2026-09-06T00:00:00Z");

  assert.deepEqual(
    projectsForPass(
      projects,
      new Map([
        ["busiest", same],
        ["busy", same],
      ]),
      2,
    ).map((project) => project.projectId),
    ["busiest", "busy"],
  );
});

test("the first fingerprint is readable, and null before there is one", async () => {
  const { client, db } = await setup();
  assert.equal(await loadFirstFingerprintAt(PROJECT, db), null);

  await seedCatalogEntry(client, { id: "filter_tasks", description: "filters" });
  const early = new Date("2026-09-01T09:00:00Z");
  await recordCatalogFingerprint(PROJECT, db, early);

  // A later corpus must not move it: this is when we started looking.
  await client.exec(
    `update runtime_catalog_entries set searchable_description = 'reworded' where entry_id = 'filter_tasks'`,
  );
  await recordCatalogFingerprint(PROJECT, db, new Date("2026-09-04T09:00:00Z"));

  assert.deepEqual(await loadFirstFingerprintAt(PROJECT, db), early);
});
