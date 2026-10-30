import assert from "node:assert/strict";
import { test } from "node:test";
import { turn } from "@/lib/ledger/test-support";
import type { AgentHealthLimits } from "@/lib/platform/entitlements";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  type Db,
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { healthReadiness } from "@/lib/readings/trace-signals/view";
import { saveLabel } from "@/lib/readings/trace-signals/workflows/label-queries";
import { loadHealthPageModel } from "@/lib/views/health/page-model";

/**
 * The page for a project that only sends OpenTelemetry, read back through the
 * loader from a real schema: the source mode from the run's turn mix, the
 * OTel band and shapes, journeys starting at the agent, and the stored
 * workflows, named by a model-written label when one exists.
 */

const NOW = new Date("2026-09-02T00:00:00Z");
const PLUS: AgentHealthLimits = {
  agentHealthSignalsShown: Infinity,
  agentHealthEvidenceTurns: 3,
  agentHealthWindowDays: 30,
};

function load(db: Db) {
  return loadHealthPageModel({ projectId: PROJECT_ID, windowDays: 7 }, "production", {
    db,
    getLimits: async () => PLUS,
    now: () => NOW,
  });
}

/** A release that sometimes fails at its third step, and a plain lookup. */
function otelRuns() {
  return [
    ...times(40, (i) =>
      turn({ lane: "otlp", traceId: `rel-${i}`, session: `rel-${i}` })
        .end("find_pr")
        .end("link_pr")
        .end("notify"),
    ),
    ...times(12, (i) =>
      turn({ lane: "otlp", traceId: `bad-${i}`, session: `bad-${i}` })
        .end("find_pr")
        .end("link_pr")
        .error("notify"),
    ),
    ...times(20, (i) =>
      turn({ lane: "otlp", traceId: `one-${i}`, session: `one-${i}` }).end("lookup"),
    ),
  ];
}

test("an OpenTelemetry-only project reads as otel, with its own band, shapes, journeys and workflows", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, otelRuns());
  await client.exec(
    `update trace_events set ingest_source = 'otlp', payload = '{"derived_from":"otlp"}'::jsonb`,
  );
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));

  const model = await load(db);
  assert.equal(healthReadiness(model), "ready");
  assert.equal(model.sourceMode, "otel");
  assert.deepEqual(
    model.tiles.map((t) => t.key),
    ["completed", "failed_calls", "wasted_calls"],
    "no model calls were sent",
  );
  assert.equal(model.tiles[0]!.value, 60 / 72);
  assert.ok(model.shapes.every((s) => s.shape.startsWith("otel_")));
  assert.equal(model.shapes.find((s) => s.shape === "otel_chain")?.count, 40);
  assert.equal(model.shapes.find((s) => s.shape === "otel_failed")?.count, 12);
  assert.equal(model.shapes.find((s) => s.shape === "otel_direct")?.count, 20);
  assert.ok(model.flow.journey?.paths.every((p) => p.start === "agent"));
  assert.deepEqual(
    model.captureUnlocks.map((u) => u.key),
    ["otel_content", "otel_tool_definitions", "otel_conversation_id"],
  );

  const release = model.workflows?.items[0];
  assert.ok(release, "the release is mined as a workflow");
  assert.deepEqual(release.focusTools, ["find_pr", "link_pr", "notify"]);
  assert.equal(release.runs, 52);
  assert.equal(release.name, "find_pr > link_pr > notify", "named by its tools without a label");

  await saveLabel(
    PROJECT_ID,
    {
      workflowId: release.id,
      inputHash: "h",
      name: "Ship a release",
      description: "Links the PR and tells the team.",
      icon: "rocket",
      model: "test",
    },
    db,
  );
  const named = await load(db);
  assert.equal(named.workflows?.items[0]?.name, "Ship a release");
  assert.equal(named.workflows?.items[0]?.description, "Links the PR and tells the team.");
  assert.equal(named.workflows?.items[0]?.icon, "rocket", "the row carries the label's icon");
  assert.equal(model.workflows?.items[0]?.icon, "workflow", "the default icon without a label");
});

test("an SDK project with a few OTLP turns too keeps the SDK page, marked mixed", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, [
    ...times(60, () => fresh().search(["a"]).invoke("a")),
    ...times(3, (i) => turn({ lane: "otlp", traceId: `t-${i}`, session: `t-${i}` }).end("a")),
  ]);
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const model = await load(db);
  assert.equal(model.sourceMode, "mixed");
  assert.deepEqual(
    model.tiles.map((t) => t.key),
    ["first_try", "detours", "junk", "wasted_calls"],
  );
  assert.equal(model.shapes.length, 6);
});

test("a broken label read never fails the page: names fall back to the tools", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, otelRuns());
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  await client.exec("drop table trace_workflow_labels");
  const model = await load(db);
  assert.equal(model.workflows?.items[0]?.name, "find_pr > link_pr > notify");
});
