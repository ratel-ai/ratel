import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPartialFacts } from "@/lib/readings/trace-signals/partial-reading-query";
import { PROJECT_ID, setupDb } from "@/lib/readings/trace-signals/signals/integration-support";

const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-12T12:00:00.000Z");
const RECENT = "2026-11-10T09:00:00.000Z";
const OLD = "2026-10-01T09:00:00.000Z";

interface Row {
  project?: string;
  trace: string;
  span: string;
  parent?: string | null;
  name: string;
  spanClass?: string;
  at?: string;
  durationMs?: number;
  error?: boolean;
  model?: string | null;
  tokens?: [number, number] | null;
}

let seq = 0;
function values(row: Row): string {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  const at = row.at ?? RECENT;
  const parent = row.parent ? `'${row.parent}'` : "null";
  const model = row.model ? `'${row.model}'` : "null";
  const [input, output] = row.tokens ?? [null, null];
  return `('${id}', '${row.project ?? PROJECT_ID}', '${row.trace}', '${row.span}', ${parent}, '${row.name}', 1,
    '${row.spanClass ?? "other"}', '${at}', '${at}', ${row.durationMs ?? 10}, ${row.error ? 2 : 1}, ${model},
    ${input ?? "null"}, ${output ?? "null"}, '{}'::jsonb)`;
}

async function seed(rows: readonly Row[]) {
  const { client, db } = await setupDb();
  await client.exec(
    `insert into organizations (id, name, slug) values ('44444444-4444-4444-8444-444444444444', 'Other', 'other')`,
  );
  await client.exec(
    `insert into projects (id, organization_id, name, slug) values ('${OTHER_PROJECT}', '44444444-4444-4444-8444-444444444444', 'Other', 'other')`,
  );
  await client.exec(`
    insert into otel_spans (id, project_id, trace_id, span_id, parent_span_id, name, kind, span_class, started_at, ended_at,
      duration_ms, status_code, model, input_tokens, output_tokens, attributes)
    values ${rows.map(values).join(",\n")}`);
  return db;
}

/** Two runs in the window (one with a failed tool), one old run, one run of another project. */
const RUNS: Row[] = [
  { trace: "a", span: "a0", name: "chat", durationMs: 1_000 },
  {
    trace: "a",
    span: "a1",
    parent: "a0",
    name: "chat.stream",
    spanClass: "llm_call",
    model: "flash",
    tokens: [100, 20],
  },
  { trace: "a", span: "a2", parent: "a0", name: "files.read", durationMs: 50 },
  {
    trace: "a",
    span: "a3",
    parent: "a0",
    name: "chat.stream",
    spanClass: "llm_call",
    model: "flash",
    tokens: [200, 30],
  },
  { trace: "b", span: "b0", name: "chat", durationMs: 3_000 },
  { trace: "b", span: "b1", parent: "b0", name: "agent_run.turn" },
  { trace: "b", span: "b2", parent: "b1", name: "files.read", error: true, durationMs: 70 },
  {
    trace: "b",
    span: "b3",
    parent: "b0",
    name: "title",
    spanClass: "llm_call",
    model: "lite",
    tokens: [10, 5],
  },
  { trace: "c", span: "c0", name: "chat", durationMs: 2_000, error: true },
  { trace: "c", span: "c1", parent: "c0", name: "files.read", durationMs: 60 },
  { trace: "old", span: "o0", name: "chat", at: OLD },
  { trace: "old", span: "o1", parent: "o0", name: "files.read", at: OLD },
  { project: OTHER_PROJECT, trace: "x", span: "x0", name: "chat" },
  { project: OTHER_PROJECT, trace: "x", span: "x1", parent: "x0", name: "files.read" },
];

test("reads the runs that started in the window, and only this project's", async () => {
  const db = await seed(RUNS);
  const facts = await loadPartialFacts(PROJECT_ID, { now: NOW, windowDays: 7 }, db);
  assert.equal(facts.runs, 3);
  assert.equal(facts.completedRuns, 1, "a failed step or a failed run did not complete");
  assert.equal(facts.calls, 7, "every span under a root");
  assert.equal(facts.failedCalls, 1);
  assert.equal(facts.modelCalls, 3);
  assert.equal(facts.tokens, 365);
  assert.ok(facts.p95RunMs !== null && facts.p95RunMs > 1_000 && facts.p95RunMs <= 3_000);
});

test("steps count calls, failures and the calls with no child span; model calls are not steps", async () => {
  const db = await seed(RUNS);
  const { steps, models } = await loadPartialFacts(PROJECT_ID, { now: NOW, windowDays: 7 }, db);
  const read = steps.find((s) => s.name === "files.read");
  assert.deepEqual(
    { ...read, p95Ms: undefined },
    { name: "files.read", calls: 3, failed: 1, leafCalls: 3, p95Ms: undefined },
  );
  assert.deepEqual(steps.find((s) => s.name === "agent_run.turn")?.leafCalls, 0);
  assert.equal(
    steps.some((s) => s.name === "chat.stream"),
    false,
  );
  assert.deepEqual(
    [...models].sort((x, y) => x.model.localeCompare(y.model)),
    [
      { model: "flash", calls: 2, tokens: 350 },
      { model: "lite", calls: 1, tokens: 15 },
    ],
  );
});

test("a wider window reads the older run too", async () => {
  const db = await seed(RUNS);
  const facts = await loadPartialFacts(PROJECT_ID, { now: NOW, windowDays: 90 }, db);
  assert.equal(facts.runs, 4);
  assert.equal(facts.steps.find((s) => s.name === "files.read")?.calls, 4);
});

test("a window with no runs is empty, not an error", async () => {
  const db = await seed(RUNS);
  const facts = await loadPartialFacts(
    PROJECT_ID,
    { now: new Date("2027-06-01T00:00:00.000Z"), windowDays: 7 },
    db,
  );
  assert.deepEqual(facts, {
    runs: 0,
    completedRuns: 0,
    calls: 0,
    failedCalls: 0,
    modelCalls: 0,
    tokens: null,
    p95RunMs: null,
    steps: [],
    models: [],
  });
});

test("a trace with two roots in the window counts its spans once", async () => {
  const db = await seed([
    { trace: "d", span: "d0", name: "chat" },
    { trace: "d", span: "d1", name: "chat" },
    { trace: "d", span: "d2", parent: "d0", name: "files.read" },
    {
      trace: "d",
      span: "d3",
      parent: "d1",
      name: "chat.stream",
      spanClass: "llm_call",
      model: "flash",
      tokens: [10, 5],
    },
  ]);
  const facts = await loadPartialFacts(PROJECT_ID, { now: NOW, windowDays: 7 }, db);
  assert.equal(facts.runs, 2);
  assert.equal(facts.calls, 2);
  assert.equal(facts.modelCalls, 1);
  assert.equal(facts.tokens, 15);
  assert.equal(facts.steps.find((s) => s.name === "files.read")?.calls, 1);
  assert.deepEqual(facts.models, [{ model: "flash", calls: 1, tokens: 15 }]);
});
