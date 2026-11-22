import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  getVariantComparison,
  listVariantExperiments,
  type VariantCompareDeps,
} from "./compare-service";
import type { VariantsDb } from "./compare-store";

/** RC-870: the per-variant read model over seeded trace summaries of two variants. */

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const WINDOW = { since: new Date("2026-11-01T00:00:00Z"), until: new Date("2026-11-08T00:00:00Z") };

let client: PGlite;
let deps: VariantCompareDeps;

before(async () => {
  client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  // control: 40 runs at $0.05, 4 errors; haiku: 40 runs at $0.01, 4 errors.
  for (let i = 0; i < 40; i++) {
    await summary(
      PROJECT_ID,
      `ctl-${i}`,
      "checkout",
      "control",
      { model: "sonnet" },
      i,
      2_000 + i * 10,
      i < 4,
      0.05,
    );
    await summary(
      PROJECT_ID,
      `hku-${i}`,
      "checkout",
      "haiku",
      { model: "haiku" },
      i,
      800 + i * 5,
      i < 4,
      0.01,
    );
  }
  // Untagged, another experiment, another project, and outside the window: never counted.
  for (let i = 0; i < 5; i++) {
    await summary(PROJECT_ID, `untagged-${i}`, null, null, {}, i, 100, true, 9);
    await summary(PROJECT_ID, `exp-only-${i}`, "checkout", null, {}, i, 100, true, 9);
    await summary(OTHER_PROJECT_ID, `other-${i}`, "checkout", "control", {}, i, 100, true, 9);
  }
  await summary(
    PROJECT_ID,
    "late",
    "checkout",
    "control",
    {},
    0,
    100,
    true,
    9,
    "2026-11-09T00:00:00Z",
  );
  await summary(PROJECT_ID, "search-1", "search", "a", {}, 0, 100, false, 0.01);
  // Runs of the first 10 control traces: two with tool errors, one abandoned.
  for (let i = 0; i < 10; i++) {
    await client.exec(`
      insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, error_count, abandoned, workflow_id)
      values ('${PROJECT_ID}', 's-${i}', 'otlp:ctl-${i}', 'otlp', 'otlp', 'closed', '2026-11-02T00:00:00Z', '2026-11-02T00:00:01Z', '2026-11-02T00:00:01Z', ${i < 2 ? 1 : 0}, ${i === 0}, ${i < 6 ? "'checkout-task'" : "null"});
    `);
  }
  // Six haiku runs of the same task.
  for (let i = 0; i < 6; i++) {
    await client.exec(`
      insert into trace_turns (project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
      values ('${PROJECT_ID}', 'h-${i}', 'otlp:hku-${i}', 'otlp', 'otlp', 'closed', '2026-11-02T00:00:00Z', '2026-11-02T00:00:01Z', '2026-11-02T00:00:01Z', 'checkout-task');
    `);
  }
  // The task's own scorer: at most 3 tool calls. These runs called none, so each passes.
  await client.exec(`
    insert into task_scorers (project_id, task_id, kind, config, updated_by)
    values ('${PROJECT_ID}', 'checkout-task', 'max_tool_calls', '{"max": 3}', 'u');
  `);
  const db = drizzle(client, { schema }) as unknown as VariantsDb;
  deps = { read: (_operation, read) => read(db), scorersEnabled: async () => true };
});

after(async () => {
  await client.close();
});

test("lists the project's experiments with their variants and run counts, tagged traces only", async () => {
  const list = await listVariantExperiments(PROJECT_ID, WINDOW, deps);
  assert.equal(list.truncated, false);
  assert.deepEqual(
    list.experiments.map((e) => [e.experiment, e.runs, e.variants]),
    [
      [
        "checkout",
        80,
        [
          { name: "control", runs: 40 },
          { name: "haiku", runs: 40 },
        ],
      ],
      ["search", 1, [{ name: "a", runs: 1 }]],
    ],
  );
});

test("returns per-variant metrics for two variants, excludes untagged traces, and names its baseline", async () => {
  const result = (await getVariantComparison(PROJECT_ID, "checkout", WINDOW, deps))!;
  assert.deepEqual(result.baseline, { name: "control", reason: "named" });
  assert.deepEqual(result.window, {
    since: WINDOW.since.toISOString(),
    until: WINDOW.until.toISOString(),
  });
  const [control, haiku] = ["control", "haiku"].map(
    (name) => result.variants.find((v) => v.name === name)!,
  );
  assert.equal(result.variants.length, 2);

  assert.equal(control!.runs, 40);
  assert.equal(control!.isBaseline, true);
  assert.deepEqual(control!.attrs, { model: "sonnet" });
  assert.equal(control!.errorRate!.value, 0.1);
  assert.ok(control!.errorRate!.interval.low < 0.1 && control!.errorRate!.interval.high > 0.1);
  assert.deepEqual(control!.tokens, { input: 4_000, output: 800, perRun: 120 });
  assert.ok(Math.abs(control!.costPerSuccessUsd!.value - (40 * 0.05) / 36) < 1e-9);
  assert.equal(control!.latencyP50Ms!.value, 2_195);
  assert.ok(control!.latencyP95Ms!.interval.high >= control!.latencyP95Ms!.value);
  assert.deepEqual(
    control!.health.map((h) => [h.kind, h.rate.value, h.rate.n]),
    [
      ["tool_errors", 0.2, 10],
      ["self_corrections", 0, 10],
      ["abandoned", 0.1, 10],
      ["detours", 0, 10],
    ],
  );
  // Six runs of each variant belong to a task and are scored.
  assert.equal(control!.scorerPassRate!.n, 6);
  assert.equal(control!.scorerPassRate!.value, 1);
  assert.equal(haiku!.scorerPassRate!.n, 6);
  assert.equal(haiku!.health.find((h) => h.kind === "tool_errors")!.rate.value, 0);

  assert.equal(haiku!.runs, 40);
  assert.equal(haiku!.isBaseline, false);
  assert.equal(haiku!.belowMinimumSample, false);
  assert.deepEqual(
    result.suggestions.map((s) => [s.kind, s.variant, s.baseline]),
    [["cheaper_model", "haiku", "control"]],
  );
});

test("with the task scorers off, the pass rate is null", async () => {
  const result = (await getVariantComparison(PROJECT_ID, "checkout", WINDOW, {
    ...deps,
    scorersEnabled: async () => false,
  }))!;
  assert.equal(result.variants.find((v) => v.name === "control")!.scorerPassRate, null);
});

test("a window wider than 30 days keeps its last 30", async () => {
  const wide = { since: new Date("2026-01-01T00:00:00Z"), until: WINDOW.until };
  const result = (await getVariantComparison(PROJECT_ID, "checkout", wide, deps))!;
  assert.equal(result.window.since, "2026-10-09T00:00:00.000Z");
  assert.equal(result.variants.length, 2);
});

test("two windows over the same traces give the same intervals", async () => {
  const later = { since: WINDOW.since, until: new Date("2026-11-08T06:00:00Z") };
  const first = (await getVariantComparison(PROJECT_ID, "checkout", WINDOW, deps))!;
  const second = (await getVariantComparison(PROJECT_ID, "checkout", later, deps))!;
  assert.deepEqual(second.variants, first.variants);
});

test("the same window gives the same intervals", async () => {
  const first = await getVariantComparison(PROJECT_ID, "checkout", WINDOW, deps);
  const again = await getVariantComparison(PROJECT_ID, "checkout", WINDOW, deps);
  assert.deepEqual(first, again);
});

test("an experiment with no tagged trace in the window, or another project's, is null", async () => {
  assert.equal(await getVariantComparison(PROJECT_ID, "missing", WINDOW, deps), null);
  const other = (await getVariantComparison(OTHER_PROJECT_ID, "checkout", WINDOW, deps))!;
  assert.deepEqual(
    other.variants.map((v) => [v.name, v.runs, v.belowMinimumSample]),
    [["control", 5, true]],
  );
  assert.match(other.variants[0]!.warning!, /5 runs, under the 30/);
});

test("the comparison read uses the variant index", async () => {
  await client.exec("set enable_seqscan = off");
  const plan = await client.query<{ "QUERY PLAN": string }>(`
    explain select variant_name, count(*) from otel_trace_summaries
    where project_id = '${PROJECT_ID}' and variant_experiment is not null and variant_name is not null
      and started_at >= '2026-11-01' and started_at < '2026-11-08' and variant_experiment = 'checkout'
    group by variant_name`);
  await client.exec("reset enable_seqscan");
  assert.match(
    plan.rows.map((row) => row["QUERY PLAN"]).join("\n"),
    /otel_trace_summaries_project_variant_started_idx/,
  );
});

async function summary(
  projectId: string,
  traceId: string,
  experiment: string | null,
  variant: string | null,
  attrs: Record<string, unknown>,
  minute: number,
  durationMs: number,
  hasError: boolean,
  costUsd: number,
  startedAt = new Date(Date.parse("2026-11-02T00:00:00Z") + minute * 60_000).toISOString(),
): Promise<void> {
  await client.query(
    `insert into otel_trace_summaries
      (project_id, trace_id, started_at, duration_ms, has_error, input_tokens, output_tokens, cost_usd, variant_experiment, variant_name, variant_attrs, spans_max_received_at)
     values ($1, $2, $3, $4, $5, 100, 20, $6, $7, $8, $9, $3)`,
    [
      projectId,
      traceId,
      startedAt,
      durationMs,
      hasError,
      costUsd,
      experiment,
      variant,
      JSON.stringify(attrs),
    ],
  );
}
