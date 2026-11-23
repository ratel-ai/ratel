import assert from "node:assert/strict";
import { test } from "node:test";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { listOpenSignals } from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { experimentRef, fixRef, insightRef, shipmentRef } from "./refs";
import { chainOf, recordLineage, sourceOf } from "./resolve";

const NOW = new Date("2026-09-02T00:00:00Z");
const OTHER = "99999999-9999-4999-8999-999999999999";
const PROPOSAL = "33333333-3333-4333-8333-333333333333";
const ACTOR = { distinctId: "system:test" } as const;

/** A project whose runs carry trace ids, with Agent health's issues computed on them. */
async function project(withTraces = true) {
  const { client, db } = await setupDb();
  let n = 0;
  const trace = () => (withTraces ? { traceId: `trace-${(n++).toString().padStart(4, "0")}` } : {});
  await seedLedger(client, db, [
    ...times(130, () =>
      fresh(trace())
        .search(["create_task", "search_tasks"], { query: "find my open tasks" })
        .invoke("search_tasks"),
    ),
    ...times(25, () =>
      fresh(trace())
        .search(["find_task"])
        .invoke("find_task")
        .search(["assign_task"])
        .invoke("assign_task"),
    ),
  ]);
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const open = await listOpenSignals(PROJECT_ID, db);
  assert.ok(open.length >= 1, "the run raised an insight");
  return { client, db, insight: open[0]! };
}

test("an insight comes from the run of its newest sampled turn, else from the reading it fired on", async () => {
  const { db, insight } = await project();
  const ctx = { projectId: PROJECT_ID, db };
  const source = await sourceOf(insightRef(insight.id), ctx);
  assert.equal(source?.stage, "monitor");
  assert.equal(source?.kind, "trace");
  assert.match(source?.id ?? "", /^trace-\d{4}$/);
  assert.equal(source?.href, `/project/${PROJECT_ID}/traces/${source?.id}`);

  const hidden = await sourceOf(insightRef(insight.id), { ...ctx, traces: false });
  assert.equal(hidden?.kind, "metric", "a plan without example turns names the metric, not a run");
  assert.equal(hidden?.id, insight.kind);
  assert.ok(hidden?.label && hidden.label.length > 0, "in the kind's own words");

  assert.equal(
    await sourceOf(insightRef(insight.id), { projectId: OTHER, db }),
    null,
    "another project reads nothing",
  );
  assert.equal(await sourceOf(insightRef("not-a-uuid"), ctx), null);
});

test("runs without trace ids still name their metric", async () => {
  const { db, insight } = await project(false);
  const source = await sourceOf(insightRef(insight.id), { projectId: PROJECT_ID, db });
  assert.equal(source?.kind, "metric");
});

test("a fix comes from its insight: an issue's own, or the one that names the drafted proposal", async () => {
  const { client, db, insight } = await project();
  const ctx = { projectId: PROJECT_ID, db };
  const fromIssue = await sourceOf(fixRef(`issue:${insight.id}`), ctx);
  assert.equal(fromIssue?.kind, "insight");
  assert.equal(fromIssue?.id, insight.id);
  assert.equal(fromIssue?.href, `/project/${PROJECT_ID}/health#signal-${insight.id}`);

  assert.equal(await sourceOf(fixRef(`craft:${PROPOSAL}`), ctx), null, "nothing names it yet");
  await client.query(
    `update trace_signals set proposal_kind = 'tool_craft', proposal_id = $1 where id = $2`,
    [PROPOSAL, insight.id],
  );
  assert.equal((await sourceOf(fixRef(`craft:${PROPOSAL}`), ctx))?.id, insight.id);
  assert.equal(await sourceOf(fixRef(`rewrite:${PROPOSAL}`), ctx), null, "the kind must match");
  assert.deepEqual(await sourceOf(fixRef("intent:t1"), ctx), {
    stage: "insights",
    kind: "intent",
    id: "t1",
    href: `/project/${PROJECT_ID}/intents?peek=t1`,
  });
});

test("a recorded link wins, replaces the last one, and the chain walks back to Monitor", async () => {
  const { db, insight } = await project();
  const ctx = { projectId: PROJECT_ID, db };
  const experiment = experimentRef("ranking-v2");
  assert.equal(
    await sourceOf(experiment, ctx),
    null,
    "an experiment's source is only what was recorded",
  );

  await recordLineage(
    { projectId: PROJECT_ID, object: experiment, source: fixRef("issue:other"), actor: ACTOR },
    db,
  );
  await recordLineage(
    {
      projectId: PROJECT_ID,
      object: experiment,
      source: insightRef(insight.id, "Wrong tool"),
      actor: ACTOR,
    },
    db,
  );
  assert.deepEqual(await sourceOf(experiment, ctx), {
    stage: "insights",
    kind: "insight",
    id: insight.id,
    label: "Wrong tool",
    href: `/project/${PROJECT_ID}/health#signal-${insight.id}`,
  });

  const shipment = shipmentRef("release-7");
  await recordLineage(
    {
      projectId: PROJECT_ID,
      object: shipment,
      source: fixRef(`issue:${insight.id}`),
      actor: ACTOR,
    },
    db,
  );
  const chain = await chainOf(shipment, ctx);
  assert.deepEqual(
    chain.map((ref) => `${ref.stage}/${ref.kind}`),
    ["monitor/trace", "insights/insight", "improve/fix", "ship/shipment"],
  );
  assert.ok(
    chain.every((ref) => typeof ref.href === "string"),
    "every step links",
  );

  const applied = await chainOf(shipmentRef(`rewrite:${PROPOSAL}`), ctx);
  assert.deepEqual(
    applied.map((ref) => ref.kind),
    ["fix", "shipment"],
    "an applied rewrite ships from its fix",
  );

  await assert.rejects(
    recordLineage(
      {
        projectId: PROJECT_ID,
        object: { stage: "ship", kind: "fix", id: "x" },
        source: insightRef(insight.id),
        actor: ACTOR,
      },
      db,
    ),
    /belongs to improve/,
  );
});

test("a cycle in recorded links ends the chain instead of looping", async () => {
  const { db } = await setupDb();
  const a = fixRef("craft:a");
  const b = { stage: "insights" as const, kind: "insight", id: "b" };
  await recordLineage({ projectId: PROJECT_ID, object: a, source: b, actor: ACTOR }, db);
  await recordLineage({ projectId: PROJECT_ID, object: b, source: a, actor: ACTOR }, db);
  const chain = await chainOf(a, { projectId: PROJECT_ID, db });
  assert.deepEqual(
    chain.map((ref) => ref.id),
    ["b", "craft:a"],
  );
});

test("Ship lists applied rewrites from their fix and recorded shipments from theirs, newest first", async () => {
  const { client, db } = await setupDb();
  const { loadShipments } = await import("./shipments");
  assert.deepEqual(await loadShipments(PROJECT_ID, db), [], "nothing shipped: Ship's empty state");

  await client.query(
    `insert into match_quality_runs (id, project_id, experiment_name, trigger, status, window_days, window_start, window_end)
     values ('77777777-7777-4777-8777-777777777777', $1, 'ratel:search-telemetry', 'manual', 'analyzed', 7, now() - interval '7 days', now())`,
    [PROJECT_ID],
  );
  await client.query(
    `insert into match_quality_proposals (id, run_id, project_id, entry_id, entry_name, status, current_searchable, current_source, proposed_searchable, rationale, evidence, preview, applied_at)
     values
       ($2, '77777777-7777-4777-8777-777777777777', $1, 'lookup_order', 'lookup_order', 'applied', 'a', 'runtime', 'b', 'r', '{}'::jsonb, '{}'::jsonb, '2026-09-01T00:00:00Z'),
       ('88888888-8888-4888-8888-888888888882', '77777777-7777-4777-8777-777777777777', $1, 'notify', 'notify', 'pending', 'a', 'runtime', 'b', 'r', '{}'::jsonb, '{}'::jsonb, null)`,
    [PROJECT_ID, PROPOSAL],
  );
  await recordLineage(
    {
      projectId: PROJECT_ID,
      object: shipmentRef("release-7"),
      source: fixRef("craft:c1", "Merge 2 tools"),
      actor: ACTOR,
    },
    db,
  );

  const rows = await loadShipments(PROJECT_ID, db);
  assert.deepEqual(
    rows.map((row) => [row.ref.id, row.title, row.source?.kind, row.source?.id]),
    [
      ["release-7", "Merge 2 tools shipped", "fix", "craft:c1"],
      [
        `rewrite:${PROPOSAL}`,
        "Searchable description of lookup_order updated",
        "fix",
        `rewrite:${PROPOSAL}`,
      ],
    ],
    "a pending rewrite is not shipped",
  );
  assert.equal(
    rows[1]!.source?.href,
    `/project/${PROJECT_ID}/improvement/fixes?peek=rewrite%3A${PROPOSAL}`,
  );
  assert.deepEqual(await loadShipments(OTHER, db), []);
});

test("an MCP shipment (mark_fix_shipped) lists on Ship with its fix and version, and chains back through its experiment", async () => {
  const { client, db } = await setupDb();
  const { loadShipments } = await import("./shipments");
  const SHIPMENT = "44444444-4444-4444-8444-444444444444";
  const EXPERIMENT = "55555555-5555-4555-8555-555555555555";
  await client.query(
    `insert into fix_experiments (id, project_id, fix_id, name, created_by) values ($2, $1, 'craft:c1', 'fix-craft-c1', 'project:x')`,
    [PROJECT_ID, EXPERIMENT],
  );
  await client.query(
    `insert into fix_shipments (id, project_id, fix_id, experiment_id, version, shipped_by) values ($2, $1, 'craft:c1', $3, '1.4.2', 'project:x')`,
    [PROJECT_ID, SHIPMENT, EXPERIMENT],
  );
  // What create_experiment and mark_fix_shipped record.
  await recordLineage(
    {
      projectId: PROJECT_ID,
      object: experimentRef("fix-craft-c1"),
      source: fixRef("craft:c1", "Merge 2 tools"),
      actor: ACTOR,
    },
    db,
  );
  await recordLineage(
    {
      projectId: PROJECT_ID,
      object: shipmentRef(SHIPMENT, "Shipped in 1.4.2"),
      source: experimentRef("fix-craft-c1"),
      actor: ACTOR,
    },
    db,
  );

  const rows = await loadShipments(PROJECT_ID, db);
  assert.deepEqual(
    rows.map((row) => [row.ref.id, row.title, row.source?.kind, row.source?.id]),
    [[SHIPMENT, "Merge 2 tools shipped in 1.4.2", "experiment", "fix-craft-c1"]],
  );
  const chain = await chainOf(rows[0]!.ref, { projectId: PROJECT_ID, db });
  assert.deepEqual(
    chain.map((ref) => [ref.kind, ref.id]),
    [
      ["fix", "craft:c1"],
      ["experiment", "fix-craft-c1"],
      ["shipment", SHIPMENT],
    ],
    "oldest first; the fix has no insight naming it here, so the chain starts at the fix",
  );
});
