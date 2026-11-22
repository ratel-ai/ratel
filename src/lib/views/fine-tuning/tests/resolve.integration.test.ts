import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { createDrizzleModelCallSource, createDrizzleUseCaseStore } from "../adapters/drizzle-store";
import { parseSelector } from "../domain/use-case";
import { loadUseCaseStats, resolveUseCase } from "../resolve";

/**
 * RC-1124: a use case resolves to the closed turns of its tasks and to their
 * model calls, in its project only. Seeded:
 * - project A, task `triage`: two closed OTLP turns (traces 1 and 2) and an
 *   open one (trace 3). Trace 1 has two calls: `chat classify` on haiku and
 *   `chat summarize` on opus. Trace 2 has one `chat classify` call on haiku.
 * - project A, task `refund`: one closed turn (trace 4) with one call.
 * - project B, task `triage`: one closed turn (trace 5) with one call.
 * - project A, an intent whose prompt landed in trace 4.
 */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "33333333-3333-4333-8333-333333333333";
const INTENT_ID = "44444444-4444-4444-8444-444444444444";
const T0 = Date.parse("2026-11-10T09:00:00.000Z");
const NOW = new Date("2026-11-20T00:00:00.000Z");

type TestDb = Parameters<typeof createDrizzleModelCallSource>[0] &
  Parameters<typeof createDrizzleUseCaseStore>[0] &
  NonNullable<Parameters<typeof insertOtelSpans>[2]>;

test("one task resolves to its closed turns and their calls, never another task's or another project's", async () => {
  const { client, db } = await seeded();
  try {
    const resolved = await resolveUseCase(
      PROJECT_A,
      parseSelector({ taskIds: ["triage"] }),
      createDrizzleModelCallSource(db),
      NOW,
    );
    assert.equal(resolved.truncated, false);
    assert.deepEqual(
      resolved.turns.map((turn) => ({
        task: turn.taskId,
        traces: turn.traceIds,
        calls: turn.calls.map((call) => `${call.spanName}/${call.model}`),
      })),
      [
        { task: "triage", traces: [traceId(2)], calls: ["chat classify/claude-haiku"] },
        {
          task: "triage",
          traces: [traceId(1)],
          calls: ["chat classify/claude-haiku", "chat summarize/claude-opus"],
        },
      ],
    );

    const inB = await resolveUseCase(
      PROJECT_B,
      parseSelector({ taskIds: ["triage"] }),
      createDrizzleModelCallSource(db),
      NOW,
    );
    assert.deepEqual(
      inB.turns.map((turn) => turn.traceIds),
      [[traceId(5)]],
    );
    assert.deepEqual(
      inB.turns.flatMap((turn) => turn.calls.map((call) => call.model)),
      ["claude-sonnet"],
    );
  } finally {
    await client.close();
  }
});

test("the call filter by model or by span name removes the other calls of the same turn", async () => {
  const { client, db } = await seeded();
  try {
    const source = createDrizzleModelCallSource(db);
    const byModel = await resolveUseCase(
      PROJECT_A,
      parseSelector({ taskIds: ["triage"], callFilter: { models: ["claude-opus"] } }),
      source,
      NOW,
    );
    assert.deepEqual(
      byModel.turns.map((turn) => turn.calls.map((call) => call.spanName)),
      [[], ["chat summarize"]],
    );
    const bySpan = await resolveUseCase(
      PROJECT_A,
      parseSelector({ taskIds: ["triage"], callFilter: { spanNames: ["chat classify"] } }),
      source,
      NOW,
    );
    assert.deepEqual(
      bySpan.turns.map((turn) => turn.calls.map((call) => call.model)),
      [["claude-haiku"], ["claude-haiku"]],
    );
  } finally {
    await client.close();
  }
});

test("an intent resolves to the turn its prompt landed in; the date range bounds the turns", async () => {
  const { client, db } = await seeded();
  try {
    const source = createDrizzleModelCallSource(db);
    const byIntent = await resolveUseCase(
      PROJECT_A,
      parseSelector({ intentIds: [INTENT_ID] }),
      source,
      NOW,
    );
    assert.deepEqual(
      byIntent.turns.map((turn) => [turn.taskId, turn.traceIds]),
      [["refund", [traceId(4)]]],
    );
    const before = await resolveUseCase(
      PROJECT_A,
      parseSelector({
        taskIds: ["triage"],
        dateRange: { from: "2026-11-01T00:00:00Z", to: "2026-11-10T09:30:00Z" },
      }),
      source,
      NOW,
    );
    assert.deepEqual(
      before.turns.map((turn) => turn.traceIds),
      [[traceId(1)]],
    );
  } finally {
    await client.close();
  }
});

test("the stats of one task: its closed turns, its calls, its model and the stored cost per run", async () => {
  const { client, db } = await seeded();
  try {
    const stats = await loadUseCaseStats(
      PROJECT_A,
      parseSelector({ taskIds: ["triage"] }),
      createDrizzleModelCallSource(db),
      NOW,
    );
    // Trace 1 costs 0.001 + 0.02, trace 2 costs 0.001: (0.021 + 0.001) / 2 = 0.011.
    assert.deepEqual(stats, {
      turns: 2,
      calls: 3,
      firstEndedAt: "2026-11-10T09:00:30.000Z",
      lastEndedAt: "2026-11-10T10:00:30.000Z",
      currentModel: "claude-haiku",
      costPerRunUsd: 0.011,
      pricedRuns: 2,
      unpricedCalls: 0,
      sampled: false,
    });
  } finally {
    await client.close();
  }
});

test("the task picker lists the project's tasks with closed turns, busiest first", async () => {
  const { client, db } = await seeded();
  try {
    assert.deepEqual(
      await createDrizzleModelCallSource(db).recentTasks(PROJECT_A, new Date(T0 - 86_400_000)),
      [
        { taskId: "triage", turns: 2 },
        { taskId: "refund", turns: 1 },
      ],
    );
  } finally {
    await client.close();
  }
});

test("use cases are scoped to their project, names are unique among live ones, and archiving frees the name", async () => {
  const { client, db } = await seeded();
  try {
    const store = createDrizzleUseCaseStore(db);
    const selector = parseSelector({ taskIds: ["triage"] });
    const created = await store.createUseCase(PROJECT_A, { name: "Triage", selector }, "user_1");
    assert.ok(created.ok);
    assert.deepEqual(created.useCase.selector, selector);
    assert.deepEqual(await store.createUseCase(PROJECT_A, { name: "Triage", selector }, "user_1"), {
      ok: false,
      reason: "name_taken",
    });
    assert.ok(
      (await store.createUseCase(PROJECT_B, { name: "Triage", selector }, "user_1")).ok,
      "another project may use the name",
    );

    assert.equal(await store.getUseCase(PROJECT_B, created.useCase.id), null);
    assert.deepEqual(await store.archiveUseCase(PROJECT_B, created.useCase.id), {
      ok: false,
      reason: "not_found",
    });
    assert.deepEqual(
      (await store.listUseCases(PROJECT_A)).map((useCase) => useCase.name),
      ["Triage"],
    );

    const renamed = await store.updateUseCase(PROJECT_A, created.useCase.id, { name: "Triage v2" });
    assert.ok(renamed.ok && renamed.useCase.name === "Triage v2");
    assert.ok((await store.archiveUseCase(PROJECT_A, created.useCase.id)).ok);
    assert.deepEqual(await store.listUseCases(PROJECT_A), []);
    assert.equal((await store.listUseCases(PROJECT_A, { includeArchived: true })).length, 1);
    assert.ok((await store.createUseCase(PROJECT_A, { name: "Triage v2", selector }, "user_1")).ok);
    assert.equal(await store.getUseCase(PROJECT_A, "not-a-uuid"), null);
  } finally {
    await client.close();
  }
});

async function seeded(): Promise<{ client: PGlite; db: TestDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT_A}', '${ORGANIZATION_ID}', 'A', 'a'), ('${PROJECT_B}', '${ORGANIZATION_ID}', 'B', 'b');
  `);
  const db = drizzle(client, { schema }) as unknown as TestDb;
  // trace index, project, task, status, minutes after T0
  const turns: [number, string, string, string, number][] = [
    [1, PROJECT_A, "triage", "closed", 0],
    [2, PROJECT_A, "triage", "closed", 60],
    [3, PROJECT_A, "triage", "open", 120],
    [4, PROJECT_A, "refund", "closed", 180],
    [5, PROJECT_B, "triage", "closed", 0],
  ];
  for (const [index, project, task, status, minutes] of turns) {
    const start = new Date(T0 + minutes * 60_000).toISOString();
    const end = new Date(T0 + minutes * 60_000 + 30_000).toISOString();
    await client.query(
      `insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
       values ($1, $2, $3, 'otlp', 'otlp', $4, $5, $6, $6, $7)`,
      [project, `s${index}`, `otlp:${traceId(index)}`, status, start, end, task],
    );
    await insertOtelSpans(
      project,
      [span(index * 10, project, index, minutes, { name: "invoke_agent" })],
      db,
    );
  }
  // trace index, project, span index, span name, model, cost
  const calls: [number, string, number, string, string, string][] = [
    [1, PROJECT_A, 11, "chat classify", "claude-haiku", "0.001"],
    [1, PROJECT_A, 12, "chat summarize", "claude-opus", "0.02"],
    [2, PROJECT_A, 21, "chat classify", "claude-haiku", "0.001"],
    [3, PROJECT_A, 31, "chat classify", "claude-haiku", "0.001"],
    [4, PROJECT_A, 41, "chat refund", "claude-sonnet", "0.005"],
    [5, PROJECT_B, 51, "chat classify", "claude-sonnet", "0.005"],
  ];
  const minutesOf = new Map(turns.map(([index, , , , minutes]) => [index, minutes]));
  for (const [index, project, spanIndex, name, model, cost] of calls) {
    const minutes = minutesOf.get(index)!;
    await insertOtelSpans(
      project,
      [
        span(spanIndex, project, index, minutes, {
          name,
          parentSpanId: spanId(index * 10),
          spanClass: "llm_call",
          model,
        }),
      ],
      db,
    );
    await client.query(
      `insert into events (project_id, occurred_at, model, cost_usd, trace_id, span_id) values ($1, $2, $3, $4, $5, $6)`,
      [
        project,
        new Date(T0 + minutes * 60_000 + spanIndex * 100).toISOString(),
        model,
        cost,
        traceId(index),
        spanId(spanIndex),
      ],
    );
  }
  await client.query(
    `insert into intent_clusters (id, project_id, level, label) values ($1, $2, 0, 'refunds')`,
    [INTENT_ID, PROJECT_A],
  );
  const [event] = (
    await client.query<{ id: string }>(
      `insert into trace_events (id, project_id, type, client_event_id, occurred_at, trace_id, payload) values (gen_random_uuid(), $1, 'prompt', 'e1', $2, $3, '{}'::jsonb) returning id`,
      [PROJECT_A, new Date(T0 + 180 * 60_000).toISOString(), traceId(4)],
    )
  ).rows;
  await client.query(
    `insert into intent_cluster_assignments (project_id, trace_event_id, cluster_id, kind, trace_id, occurred_at) values ($1, $2, $3, 'prompt', $4, $5)`,
    [PROJECT_A, event!.id, INTENT_ID, traceId(4), new Date(T0 + 180 * 60_000).toISOString()],
  );
  return { client, db };
}

function traceId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

function spanId(index: number): string {
  return index.toString(16).padStart(16, "0");
}

function span(
  index: number,
  projectId: string,
  trace: number,
  minutes: number,
  overrides: Partial<NewOtelSpan>,
): NewOtelSpan {
  const startedAt = new Date(T0 + minutes * 60_000 + index * 100);
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    projectId,
    receivedAt: startedAt,
    traceId: traceId(trace),
    spanId: spanId(index),
    parentSpanId: null,
    name: "span",
    kind: 1,
    spanClass: "other",
    startedAt,
    endedAt: new Date(startedAt.getTime() + 50),
    durationMs: 50,
    statusCode: 1,
    serviceName: null,
    scopeName: "fixture",
    operationName: null,
    providerName: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    costUsd: null,
    searchOrigin: null,
    searchTarget: null,
    searchQuery: null,
    searchTopK: null,
    searchHitCount: null,
    experimentName: null,
    experimentArm: null,
    experimentRole: null,
    experimentAttrs: {},
    attributes: {},
    attrsTruncated: false,
    ...overrides,
  };
}
