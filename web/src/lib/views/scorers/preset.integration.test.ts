import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { loadRuns } from "@/lib/views/eval-gate/runs";
import { recordedView } from "@/lib/views/eval-gate/simulate";
import { scoreRun } from "@/lib/views/task-scorers/engine";
import type { Scorer as TaskScorer } from "@/lib/views/task-scorers/types";
import { changeScorer, type ScorerActionDeps } from "./actions";
import { MAX_SCORERS, parseScorerDraft } from "./config";
import type { JudgeEngine } from "./judge";
import { definitionOf } from "./preset";
import {
  attachScorer,
  countScorers,
  createScorer,
  deleteScorer,
  detachScorer,
  getScorer,
  latestScores,
  listScorers,
  setScorerEnabled,
  updateScorer,
} from "./store";
import { type SweepOptions, sweepScorers } from "./sweep";
import type { ScorerDraft } from "./types";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const TASK = "task-a";

/** Two runs of the task: a short clean one, and a long one that ends on a failed call. */
const RUNS: RunInput[] = [
  {
    n: 1,
    durationMs: 1_000,
    costUsd: 0.01,
    finish: "stop",
    hits: ["search_hotels", "book"],
    calls: [
      ["search_hotels", "ok"],
      ["book", "ok"],
    ],
  },
  {
    n: 2,
    durationMs: 9_000,
    costUsd: 0.5,
    finish: "stop",
    hits: ["book", "cancel"],
    calls: [
      ["book", "error"],
      ["book", "ok"],
      ["cancel", "ok"],
      ["cancel", "error"],
    ],
  },
];

/** The 6 measured kinds, each with a setting the two runs fall on both sides of. */
const PRESETS: TaskScorer[] = [
  { kind: "ends_well" },
  { kind: "max_self_corrections", max: 0 },
  { kind: "max_latency_ms", max: 2_000 },
  { kind: "max_cost_usd", max: 0.1 },
  { kind: "expected_tool", tool: "search_hotels" },
  { kind: "max_tool_calls", max: 3 },
];

interface RunInput {
  n: number;
  durationMs: number;
  costUsd: number;
  finish: string;
  hits: string[];
  calls: [string, "ok" | "error"][];
}

test("each of the 7 task kinds scores a trace of its task as engine.ts grades the run", async () => {
  const { client, db, addRun, scored } = await setup();
  try {
    for (const run of RUNS) await addRun(run);
    await addRun({ ...RUNS[0]!, n: 3, task: "task-b" });
    const ids = new Map<string, string>();
    for (const preset of PRESETS) ids.set(preset.kind, await scorer(client, db, preset));
    ids.set(
      "judge_criteria",
      await scorer(client, db, { kind: "judge_criteria", criteria: "Did it book?" }),
    );

    // The judge answers "pass" for the first run's trace and "fail" for the second.
    const engine: JudgeEngine = {
      model: "fake",
      usdPerInputToken: 0.000001,
      async ask(question) {
        const choice = question.input.includes("run 1") ? "pass" : "fail";
        return { answer: { choice, confidence: 0.9 }, inputTokens: 100 };
      },
    };
    const options: SweepOptions = {
      flagOn: async () => true,
      judge: {
        engine,
        loadConversation: async (_projectId, traceId) => ({
          input: `run ${traceId.slice(-1)}`,
          output: "done",
        }),
      },
    };
    await sweepScorers(options, db);

    const runs = await loadRuns(PROJECT, [turnId(1), turnId(2)], db);
    let passes = 0;
    let fails = 0;
    for (const preset of PRESETS) {
      const got = await scored(ids.get(preset.kind)!);
      for (const n of [1, 2]) {
        const run = runs.get(turnId(n))!;
        const tool = preset.kind === "expected_tool" ? preset.tool : null;
        const [expected] = scoreRun(recordedView(run, tool), [preset]);
        assert.ok(expected && expected.status !== "skip", `${preset.kind} measures run ${n}`);
        assert.equal(got.get(traceOf(n)), expected.status === "pass", `${preset.kind} run ${n}`);
        if (expected.status === "pass") passes++;
        else fails++;
      }
      assert.equal(got.has(traceOf(3)), false, "a trace of another task is not scored");
    }
    assert.ok(passes > 0 && fails > 0, `${passes} passes, ${fails} fails`);

    const criteria = await scored(ids.get("judge_criteria")!);
    for (const n of [1, 2]) {
      const [expected] = scoreRun(
        { ...recordedView(runs.get(turnId(n))!), criteriaPass: n === 1 },
        [{ kind: "judge_criteria", criteria: "Did it book?" }],
      );
      assert.equal(criteria.get(traceOf(n)), expected!.status === "pass");
    }

    // One score per trace: a second sweep adds nothing.
    await client.exec("update trace_scorers set cursor_at = now() - interval '1 hour'");
    const again = await sweepScorers(options, db);
    assert.equal(again.scoresWritten, 0);
  } finally {
    await client.close();
  }
});

test("a trace of an open run is held for later, and a trace of no run gets no preset result", async () => {
  const { client, db, addRun, scored } = await setup();
  try {
    await addRun({ ...RUNS[0]!, status: "open" });
    await client.exec(`insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms,
        has_error, input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at)
      values ('${PROJECT}', 'loose', now(), 5, false, 0, 0, 0, now(), now() - interval '60 seconds')`);
    const id = await scorer(client, db, { kind: "ends_well" });
    const result = await sweepScorers({ flagOn: async () => true }, db);
    assert.deepEqual((await scored(id)).size, 0);
    // The open run's trace is held, not passed (the cursor waits before it); the loose one is not
    // of the task. `review-findings.integration.test.ts` scores the held trace once its run closes.
    assert.equal(result.skipped, 0);
  } finally {
    await client.close();
  }
});

test("a preset counts against the limit of scorers, as a judge does", async () => {
  const { client, db } = await setup();
  try {
    for (let n = 0; n < MAX_SCORERS - 1; n++)
      await createScorer(PROJECT, draft({ kind: "ends_well" }), "u1", db);
    const deps = actionDeps(db);
    const create = (task: TaskScorer) =>
      changeScorer({ projectId: PROJECT, action: "create", draft: draft(task) }, deps);
    assert.equal((await create({ kind: "max_tool_calls", max: 3 })).ok, true);
    for (const task of [
      { kind: "max_latency_ms", max: 10 },
      { kind: "judge_criteria", criteria: "Did it book?" },
    ] as TaskScorer[])
      assert.deepEqual(await create(task), {
        ok: false,
        error: `This project has ${MAX_SCORERS} scorers, and the limit is ${MAX_SCORERS}. Delete 1 to create another.`,
      });
    assert.equal(await countScorers(PROJECT, db), MAX_SCORERS);
  } finally {
    await client.close();
  }
});

test("over the limit, create is refused with the real count; update, enable, attach and delete still work", async () => {
  const { client, db } = await setup();
  try {
    // 130 scorers, as a project can hold after the task scorers' conversion (legacy excess).
    await client.exec(`insert into trace_scorers (project_id, name, kind, config, created_by, updated_by)
      select '${PROJECT}', 'Fast ' || n, 'check', '{"path":"duration_ms","op":"lte","value":1000}', 'u1', 'u1'
      from generate_series(1, ${MAX_SCORERS + 30}) n`);
    const deps = actionDeps(db);
    const change = (raw: object) => changeScorer({ projectId: PROJECT, ...raw }, deps);
    assert.deepEqual(
      await change({ action: "create", draft: draft({ kind: "max_tool_calls", max: 3 }) }),
      {
        ok: false,
        error: `This project has ${MAX_SCORERS + 30} scorers, and the limit is ${MAX_SCORERS}. Delete 31 to create another.`,
      },
    );
    const [first] = await listScorers(PROJECT, db);
    const scorerId = first!.id;
    const { kind, config, filter, sampleRate } = first!;
    const updated = {
      name: "Faster",
      kind,
      config,
      filter,
      tasks: null,
      sampleRate,
      enabled: true,
    };
    for (const raw of [
      { action: "update", scorerId, draft: updated },
      { action: "set_enabled", scorerId, enabled: false },
      { action: "attach", scorerId, taskId: TASK, narrow: true },
      { action: "delete", scorerId },
    ])
      assert.deepEqual(await change(raw), { ok: true, scorerId }, raw.action);
    assert.equal(await countScorers(PROJECT, db), MAX_SCORERS + 29);
  } finally {
    await client.close();
  }
});

test("the task criteria judge spends from the daily judge budget, and stops when it is spent", async () => {
  const { client, db, addRun, scored } = await setup();
  try {
    await addRun(RUNS[0]!);
    const id = await scorer(client, db, { kind: "judge_criteria", criteria: "Did it book?" });
    await client.exec(
      `insert into scorer_judge_spend (project_id, day, usd) values ('${PROJECT}', current_date, 10)`,
    );
    let asked = 0;
    const result = await sweepScorers(
      {
        flagOn: async () => true,
        judge: {
          engine: {
            model: "fake",
            usdPerInputToken: 0.000001,
            async ask() {
              asked++;
              return { answer: { choice: "pass", confidence: 1 }, inputTokens: 100 };
            },
          },
          loadConversation: async () => ({ input: "hi", output: "done" }),
        },
      },
      db,
    );
    assert.equal(asked, 0);
    assert.equal((await scored(id)).size, 0);
    assert.deepEqual(result.budgetSkips, [{ projectId: PROJECT, scorerId: id, traces: 1 }]);
  } finally {
    await client.close();
  }
});

test("a preset draft needs its tasks and a valid setting; judge_criteria becomes a judge", () => {
  const parse = (raw: object) => parseScorerDraft({ ...draft({ kind: "ends_well" }), ...raw });
  assert.equal(parse({ tasks: null }).ok, false);
  assert.equal(parse({ config: { preset: "max_tool_calls", max: 1.5 } }).ok, false);
  assert.equal(parse({ config: { preset: "expected_tool", tool: " " } }).ok, false);
  assert.equal(parse({ config: { preset: "nope" } }).ok, false);
  const criteria = parse({ config: { preset: "judge_criteria", criteria: " Did it book? " } });
  assert.ok(criteria.ok);
  assert.deepEqual(
    [criteria.draft.kind, criteria.draft.config],
    ["judge", { prompt: "Did it book?", output: "boolean" }],
  );
});

function draft(task: TaskScorer): ScorerDraft {
  return {
    ...definitionOf(task),
    name: task.kind,
    filter: {},
    tasks: [TASK],
    sampleRate: 100,
    enabled: true,
  };
}

function actionDeps(db: ReturnType<typeof getDb>): ScorerActionDeps {
  return {
    getSession: async () => ({ user: { id: "u1", externalId: "u1" } }),
    findProjectScope: async (projectId) => ({
      project: { id: projectId },
      organization: { id: ORG },
    }),
    enabled: async () => true,
    isRestricted: async () => false,
    get: (projectId, id) => getScorer(projectId, id, db),
    count: (projectId) => countScorers(projectId, db),
    create: (projectId, value, actor) => createScorer(projectId, value, actor, db),
    update: (projectId, id, value, actor) => updateScorer(projectId, id, value, actor, db),
    setEnabled: (projectId, id, on, actor) => setScorerEnabled(projectId, id, on, actor, db),
    remove: (projectId, id) => deleteScorer(projectId, id, db),
    attach: (projectId, id, task, actor) => attachScorer(projectId, id, task, actor, db),
    detach: (projectId, id, task, actor) => detachScorer(projectId, id, task, actor, db),
    observe: async () => {},
  };
}

async function scorer(
  client: { exec(sql: string): Promise<unknown> },
  db: ReturnType<typeof getDb>,
  task: TaskScorer,
) {
  const id = await createScorer(PROJECT, draft(task), "u1", db);
  await client.exec(
    `update trace_scorers set cursor_at = now() - interval '1 hour', created_at = now() - interval '1 hour' where id = '${id}'`,
  );
  return id;
}

function turnId(n: number) {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
}

function traceOf(n: number) {
  return `trace-${n}`;
}

async function setup() {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
    insert into trace_signal_runs (project_id, trigger, status, window_days, window_start, window_end, ledger_through)
      values ('${PROJECT}', 'scheduled', 'completed', 7, now() - interval '7 days', now() + interval '1 day', now() + interval '1 day');
  `);
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;

  /** One run of a task: its turn keyed on its trace, its search and calls, its model call, its summary. */
  const addRun = async (run: RunInput & { task?: string; status?: string }) => {
    const trace = traceOf(run.n);
    const start = new Date(Date.now() - 600_000);
    const end = new Date(start.getTime() + run.durationMs);
    await client.query(
      `insert into trace_turns (id, project_id, session_id, turn_key, turn_source, lane, status, started_at, ended_at, last_received_at, workflow_id)
       values ($1, $2, $3, $4, 'otlp', 'otlp', $5, $6, $7, $7, $8)`,
      [
        turnId(run.n),
        PROJECT,
        `s-${run.n}`,
        `otlp:${trace}`,
        run.status ?? "closed",
        start.toISOString(),
        end.toISOString(),
        run.task ?? TASK,
      ],
    );
    const steps: [string, string | null, string | null][] = [
      ["search", null, null],
      ...run.calls.map(([tool, outcome]) => ["invoke", tool, outcome] as [string, string, string]),
    ];
    for (const [index, [kind, target, outcome]] of steps.entries())
      await client.query(
        `insert into trace_turn_steps (turn_id, project_id, ordinal, kind, event_type, trace_event_id, occurred_at, received_at, target_type, target_id, outcome, search_type, hit_ids, top_k)
         values ($1, $2, $3, $4, $5, gen_random_uuid(), $6, $6, $7, $8, $9, $10, $11, $12)`,
        [
          turnId(run.n),
          PROJECT,
          index + 1,
          kind,
          kind === "search" ? "search_end" : "invoke_end",
          new Date(start.getTime() + index).toISOString(),
          target ? "tool" : null,
          target,
          outcome,
          kind === "search" ? "tool_search" : null,
          kind === "search" ? run.hits : null,
          kind === "search" ? 5 : null,
        ],
      );
    await client.query(
      `insert into events (project_id, occurred_at, finish_reason, cost_usd, trace_id)
       values ($1, $2, $3, $4, $5)`,
      [PROJECT, end.toISOString(), run.finish, run.costUsd, trace],
    );
    await client.query(
      `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
         input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at)
       values ($1, $2, $3, $4, false, 1, 1, $5, now(), now() - interval '60 seconds')`,
      [PROJECT, trace, start.toISOString(), run.durationMs, run.costUsd],
    );
  };
  /** A scorer's results by trace: true for a pass. */
  const scored = async (scorerId: string) =>
    new Map(
      (await latestScores(PROJECT, scorerId, 1000, db)).map((row) => [
        row.traceId,
        row.passed === true,
      ]),
    );
  return { client, db, addRun, scored };
}
