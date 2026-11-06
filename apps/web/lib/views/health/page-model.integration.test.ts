import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentHealthLimits } from "@/lib/platform/entitlements";
import { computeProjectTraceSignals } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  type Db,
  jobDeps,
  PROJECT_ID,
  seedLedger,
  setupDb,
} from "@/lib/readings/trace-signals/signals/integration-support";
import { listOpenSignals } from "@/lib/readings/trace-signals/signals/queries";
import { fresh, times } from "@/lib/readings/trace-signals/signals/test-fixtures";
import { applyPlanLimits, healthReadiness } from "@/lib/readings/trace-signals/view";
import { type EvidenceDb, loadEvidenceTurns } from "@/lib/views/health/evidence";
import { MOCK_HEALTH_MODEL } from "@/lib/views/health/mock-fixture";
import { loadHealthPageModel } from "@/lib/views/health/page-model";

const NOW = new Date("2026-09-02T00:00:00Z");
const FREE: AgentHealthLimits = {
  agentHealthSignalsShown: 3,
  agentHealthEvidenceTurns: 0,
  agentHealthWindowDays: 7,
};
const PLUS: AgentHealthLimits = {
  agentHealthSignalsShown: Infinity,
  agentHealthEvidenceTurns: 3,
  agentHealthWindowDays: 30,
};

function load(db: Db, nodeEnv: string, limits: AgentHealthLimits = PLUS) {
  return loadHealthPageModel({ projectId: PROJECT_ID, windowDays: 7 }, nodeEnv, {
    db,
    getLimits: async () => limits,
    now: () => NOW,
  });
}

function problems() {
  return [
    ...times(130, () =>
      fresh()
        .search(["create_task", "search_tasks"], { query: "find my open tasks" })
        .invoke("search_tasks"),
    ),
    ...times(25, () =>
      fresh()
        .search(["find_task"])
        .invoke("find_task")
        .search(["assign_task"])
        .invoke("assign_task"),
    ),
  ];
}

/** More kinds of trouble, for the plan cut: retries of one ask, and a tool that fails twice. */
function moreProblems() {
  const ask = { query: "open the pricing doc" };
  return [
    ...problems(),
    ...times(12, () =>
      fresh()
        .search(["search_documents"], ask)
        .search(["get_document_content"], ask)
        .invoke("get_document_content"),
    ),
    ...times(6, () =>
      fresh()
        .search(["bulk_update"])
        .invoke("bulk_update")
        .error("bulk_update")
        .invoke("bulk_update")
        .error("bulk_update"),
    ),
  ];
}

test("no ledger: the empty state everywhere but development, where the demo fixture shows", async () => {
  const { db } = await setupDb();
  for (const env of ["production", "test", undefined]) {
    const model = await load(db, env as string);
    assert.equal(healthReadiness(model), "no_telemetry", String(env));
    assert.equal(model.signals.length, 0);
    assert.notEqual(model.turns, MOCK_HEALTH_MODEL.turns);
  }
  const dev = await load(db, "development");
  assert.equal(dev.turns, MOCK_HEALTH_MODEL.turns);
  assert.equal(dev.windowDays, 7);
});

test("a ledger below the floor reads as collecting, even in development", async () => {
  const { client, db } = await setupDb();
  await seedLedger(
    client,
    db,
    times(10, () => fresh().search(["a"]).invoke("a")),
  );
  for (const env of ["production", "development"]) {
    const model = await load(db, env);
    assert.equal(healthReadiness(model), "collecting", env);
    assert.equal(model.turns, 10);
    assert.ok(model.tiles.every((t) => t.value === null));
    assert.equal(model.computedAt, null);
  }
});

test("after a run the page is ready with tiles, shapes, flow and signals", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, problems());
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));

  const model = await load(db, "production");
  assert.equal(healthReadiness(model), "ready");
  assert.equal(model.turns, 155);
  assert.equal(model.captureLevel, "content");
  assert.equal(
    model.shapes.reduce((sum, s) => sum + s.count, 0),
    155,
  );
  assert.equal(
    model.tiles.find((t) => t.key === "first_try")?.value,
    1,
    "each chain step is a fresh search for a new need, not a retry",
  );
  assert.ok(model.flow.nodes.some((n) => n.id === "create_task" && n.tint === "magnet"));
  const magnet = model.signals.find((s) => s.kind === "magnet");
  assert.ok(magnet);
  assert.equal(magnet.claim, "create_task rides into 72% of lists and is never picked.");
  assert.equal(magnet.evidence.turns.length, 3);
  const story = magnet.evidence.turns[0]!;
  assert.deepEqual(story.steps[0], {
    kind: "search",
    query: { state: "captured", text: "find my open tasks" },
    listed: 2,
    flag: { label: "create_task at #1 · not needed here" },
    eventId: story.steps[0]?.eventId,
  });
  // The step names its live event, which is what "Open in Traces" focuses.
  assert.match(story.steps[0]?.eventId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(model.evidenceTurnsPerSignal, 3);
});

test("plan slicing: free sees three signals and reads no evidence at all", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, moreProblems());
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const open = await listOpenSignals(PROJECT_ID, db);
  assert.ok(open.length > 3, `fixture opens ${open.length} signals`);

  const model = applyPlanLimits(await load(db, "production", FREE), FREE);
  assert.equal(model.signals.length, 3);
  assert.equal(model.lockedCount, open.length - 3);
  assert.equal(model.evidenceTurnsPerSignal, 0);
  assert.ok(model.signals.every((s) => s.evidence.turns.length === 0));

  const throwing = {
    select: () => {
      throw new Error("free plans must not read evidence rows");
    },
  } as unknown as EvidenceDb;
  const none = await loadEvidenceTurns(
    PROJECT_ID,
    [{ signalId: "s", kind: "magnet", subjectIds: ["a"], turnIds: ["t"] }],
    0,
    new Map(),
    throwing,
  );
  assert.equal(none.size, 0);
});

test("evidence reads query text live: pruned events are expired, missing text is not captured", async () => {
  const { client, db } = await setupDb();
  await seedLedger(client, db, [
    ...times(130, (i) =>
      fresh()
        .search(["create_task", "search_tasks"], { query: i % 2 === 0 ? "find my open tasks" : "" })
        .invoke("search_tasks"),
    ),
  ]);
  await computeProjectTraceSignals(PROJECT_ID, { trigger: "manual" }, jobDeps(db, NOW));
  const before = await load(db, "production");
  const states = before.signals
    .find((s) => s.kind === "magnet")!
    .evidence.turns.map((t) => (t.steps[0] as { query: { state: string } }).query.state);
  assert.ok(states.every((s) => s === "captured" || s === "not_captured"));
  assert.ok(states.includes("not_captured") || states.includes("captured"));

  await client.exec(`delete from trace_events`);
  const after = await load(db, "production");
  const magnet = after.signals.find((s) => s.kind === "magnet")!;
  assert.equal(magnet.evidence.turns.length, 3, "turns outlive the prune");
  for (const turn of magnet.evidence.turns) {
    assert.deepEqual((turn.steps[0] as { query: unknown }).query, { state: "expired" });
    assert.equal(turn.traceId, null);
  }
});
