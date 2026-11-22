import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import { jobs } from "@/lib/jobs/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { OrganizationFlagDeps } from "@/lib/platform/organization-flags";
import type { ModelCall } from "@/lib/views/eval-gate/calls";
import { emptyChange } from "@/lib/views/eval-gate/change";
import { standInModels } from "@/lib/views/eval-gate/models";
import type { FixChange, RunRecord } from "@/lib/views/eval-gate/types";
import { evalRuns } from "@/lib/views/evals/schema";
import { fixDrafts } from "@/lib/views/fix-drafts/schema";
import { buildFixes } from "@/lib/views/fixes/build";
import { fixesInput } from "@/lib/views/fixes/test-fixtures";
import type { Fix } from "@/lib/views/fixes/types";
import { upsertScorer } from "@/lib/views/task-scorers/store";
import { createDrizzleEvalStore } from "../adapters/drizzle-store";
import type { EvalReplay } from "../job";
import { loadRunsPage } from "../page";
import {
  fixSimulations,
  type RequestEvalSimulationDeps,
  type RunEvalSimulationDeps,
  requestEvalSimulation,
  runEvalSimulationJob,
  simulationRows,
} from "../simulation";

/**
 * Owned (ADR-0030): a fix simulation reads the fix's drafted change, which the core resolves only
 * with `FF_EVAL_GATE` on (fix drafts are the eval gate's); upstream rode one flag for both.
 */
const SAVED_EVAL_GATE = process.env.FF_EVAL_GATE;
before(() => {
  process.env.FF_EVAL_GATE = "true";
});
after(() => {
  if (SAVED_EVAL_GATE === undefined) delete process.env.FF_EVAL_GATE;
  else process.env.FF_EVAL_GATE = SAVED_EVAL_GATE;
});

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const SEAT_TURN = "44444444-4444-4444-8444-444444444444";
const SPLIT_TURN = "55555555-5555-4555-8555-555555555555";
const OTHER_TURN = "66666666-6666-4666-8666-666666666666";
const FLAGS_ON: OrganizationFlagDeps = {
  isConfigured: () => true,
  readOverride: () => undefined,
  evaluate: async () => true,
};
const FLAGS_OFF: OrganizationFlagDeps = { ...FLAGS_ON, evaluate: async () => false };

/** A merge: one `pick_seat` call stands in for the seat map and the selection. */
const MERGE: FixChange = {
  ...emptyChange(),
  collapse: ["get_seat_map", "select_seat"],
  replay: {
    tools: [
      {
        name: "pick_seat",
        description: "Reads the seat map and takes the seat.",
        parameters: { type: "object", properties: {} },
        replaces: ["get_seat_map", "select_seat"],
      },
    ],
    failClearly: [],
    prerequisite: null,
    skill: null,
  },
};

test("a fix runs its own tasks' evals by default: one queued line and its job, tracked once, a second click gets the same line", async () => {
  const { client, db, request, tracked, fix } = await setup();
  try {
    await seedEvals(db);
    const first = await requestEvalSimulation(PROJECT, fix.id, undefined, request);
    assert.ok(first.ok, first.ok ? "" : first.error);
    assert.deepEqual(
      [
        first.value.kind,
        first.value.fixId,
        first.value.suite,
        first.value.status,
        first.value.evalCount,
      ],
      ["simulation", fix.id, "Related tasks", "queued", 5],
    );
    const queued = await db.select().from(jobs);
    assert.deepEqual(
      queued.map((job) => job.kind),
      ["simulate_eval_set"],
    );
    assert.equal((queued[0]!.payload as { runId: string }).runId, first.value.id);
    const again = await requestEvalSimulation(PROJECT, fix.id, { kind: "related" }, request);
    assert.ok(again.ok);
    assert.equal(again.value.id, first.value.id);
    assert.equal((await db.select().from(jobs)).length, 1);
    assert.deepEqual(tracked, [
      { runId: first.value.id, fixId: fix.id, suite: "related", evalCount: 5 },
    ]);
  } finally {
    await client.close();
  }
});

test("Run evals queues all evals, evals failing today, or one task's evals, each as its own line; Add evals runs a given list", async () => {
  const { client, db, request, fix } = await setup();
  try {
    const ids = await seedEvals(db);
    const store = createDrizzleEvalStore(db);
    const today = await store.createRun({
      projectId: PROJECT,
      kind: "nightly",
      createdBy: "t",
      evalCount: 2,
    });
    await store.recordResults(PROJECT, today.id, [
      { evalId: ids.strict, passed: false, verdicts: [] },
      { evalId: ids.other, passed: true, verdicts: [] },
    ]);
    await store.updateRun(PROJECT, today.id, { status: "completed", finishedAt: new Date() });

    const all = await requestEvalSimulation(PROJECT, fix.id, { kind: "all" }, request);
    const failing = await requestEvalSimulation(PROJECT, fix.id, { kind: "failing" }, request);
    const task = await requestEvalSimulation(
      PROJECT,
      fix.id,
      { kind: "task", workflowId: "wf-other" },
      request,
    );
    const added = await requestEvalSimulation(
      PROJECT,
      fix.id,
      { kind: "list", evalIds: [ids.other, ids.strict] },
      request,
    );
    for (const result of [all, failing, task, added])
      assert.ok(result.ok, result.ok ? "" : result.error);
    assert.deepEqual(
      [all, failing, task, added].map((r) => r.ok && [r.value.suite, r.value.evalCount]),
      [
        ["All evals", 6],
        ["Failing today", 1],
        ["Task wf-other", 1],
        ["Added evals", 2],
      ],
    );
    assert.equal(new Set([all, failing, task, added].map((r) => r.ok && r.value.id)).size, 4);
    assert.equal((await db.select().from(jobs)).length, 4);

    const empty = await requestEvalSimulation(
      PROJECT,
      fix.id,
      { kind: "task", workflowId: "wf-none" },
      request,
    );
    assert.deepEqual(empty, { ok: false, error: "No evals are in this suite." });
    assert.deepEqual(await requestEvalSimulation(PROJECT, fix.id, { kind: "nope" }, request), {
      ok: false,
      error: "That is not a suite of evals.",
    });
  } finally {
    await client.close();
  }
});

test("flag off or an unknown fix: the action refuses and queues nothing", async () => {
  const off = await setup(FLAGS_OFF);
  try {
    await seedEvals(off.db);
    assert.deepEqual(await requestEvalSimulation(PROJECT, off.fix.id, undefined, off.request), {
      ok: false,
      error: "Evals are off for this organization.",
    });
    assert.equal((await off.db.select().from(evalRuns)).length, 0);
  } finally {
    await off.client.close();
  }
  const on = await setup();
  try {
    await seedEvals(on.db);
    assert.deepEqual(await requestEvalSimulation(PROJECT, "craft:nothing", undefined, on.request), {
      ok: false,
      error: "This fix does not exist in the project.",
    });
    assert.equal((await on.db.select().from(jobs)).length, 0);
    assert.equal(on.tracked.length, 0);
  } finally {
    await on.client.close();
  }
});

test("the job replays each eval without and with the fix; both sides read back as fixed, broke, unverified, and one replay for an eval the fix does not touch", async () => {
  const { client, db, request, fix } = await setup();
  try {
    const ids = await seedEvals(db);
    const queued = await requestEvalSimulation(PROJECT, fix.id, { kind: "all" }, request);
    assert.ok(queued.ok, queued.ok ? "" : queued.error);
    const [job] = await db.select().from(jobs);
    const done = await runEvalSimulationJob(PROJECT, job!.payload, jobDeps(db));
    assert.deepEqual(done, { ran: true, status: "completed", runId: queued.value.id });

    const read = await simulationRows(PROJECT, queued.value.id, db);
    assert.ok(read);
    assert.equal(read.run.status, "completed");
    const rows = new Map(read.rows.map((row) => [row.evalId, row]));

    const strict = rows.get(ids.strict)!;
    assert.deepEqual(
      [strict.before?.passed, strict.after?.passed, strict.outcome],
      [false, true, "fixed"],
    );
    assert.deepEqual(
      strict.before?.toolAnswers.map((a) => a.tool),
      ["get_seat_map", "select_seat"],
    );
    assert.deepEqual(
      strict.after?.toolAnswers.map((a) => [a.tool, a.source]),
      [["pick_seat", "composed"]],
    );

    const expects = rows.get(ids.expects)!;
    assert.deepEqual(
      [expects.before?.passed, expects.after?.passed, expects.outcome],
      [true, false, "broke"],
    );

    const split = rows.get(ids.split)!;
    assert.deepEqual(
      [split.before?.passed, split.after?.passed, split.outcome],
      [false, true, "unverified"],
      "The merged call's second half was a stand-in's answer.",
    );
    assert.ok(split.after?.toolAnswers.some((a) => a.source === "stand-in"));

    const other = rows.get(ids.other)!;
    assert.deepEqual(
      [other.before?.passed, other.after, other.outcome],
      [true, null, "same"],
      "Nothing the fix changes: one replay, same as today.",
    );

    const gone = rows.get(ids.gone)!;
    assert.deepEqual(
      [gone.before?.error, gone.after, gone.outcome],
      ["The recorded run is gone.", null, null],
    );

    const [line] = await fixSimulations(PROJECT, fix.id, db);
    assert.ok(line);
    assert.equal(line.run.id, queued.value.id);
    assert.deepEqual(
      line.tally,
      { total: 6, passed: 4, today: 2, fixed: 2, broke: 1, unverified: 1 },
      "The suggestion runs too (RC-315): it is fixed like Strict.",
    );
    assert.deepEqual(line.tasks, ["wf-1", "wf-other"]);

    const store = createDrizzleEvalStore(db);
    assert.equal(
      (await store.recentResults(PROJECT, [ids.strict], 1)).size,
      0,
      "A simulation is not the agent today: a manual run compares with manual and nightly runs only.",
    );
    const listed = await loadRunsPage(PROJECT, "user_1", { db, flagDeps: FLAGS_ON });
    assert.deepEqual(
      listed?.runs.map((row) => row.summary),
      [{ passed: 4, total: 6, nowFails: 1, fixed: 2 }],
      "The Runs list counts each eval once.",
    );
  } finally {
    await client.close();
  }
});

test("a queued line reads with no results yet, and other fixes' simulations stay off its page", async () => {
  const { client, db, request, fix } = await setup();
  try {
    await seedEvals(db);
    const store = createDrizzleEvalStore(db);
    await store.createRun({
      projectId: PROJECT,
      kind: "simulation",
      fixId: "issue:another",
      createdBy: "t",
      suite: "All evals",
      evalCount: 1,
    });
    const queued = await requestEvalSimulation(PROJECT, fix.id, undefined, request);
    assert.ok(queued.ok);
    const lines = await fixSimulations(PROJECT, fix.id, db);
    assert.deepEqual(
      lines.map((line) => [line.run.id, line.run.status, line.tally.total]),
      [[queued.value.id, "queued", 0]],
    );
  } finally {
    await client.close();
  }
});

/* - fixtures ---------------------------------------------------------------- */

test("RC-322: a fix simulation archives no suggested eval, however many there are", async () => {
  const { client, db, request, fix } = await setup();
  try {
    const store = createDrizzleEvalStore(db);
    for (let n = 0; n < 45; n++)
      await store.createEval({
        projectId: PROJECT,
        name: `S${n}`,
        message: "m",
        origin: "auto",
        createdBy: "t",
        status: "suggested",
        tasks: ["wf-1"],
      });
    const queued = await requestEvalSimulation(PROJECT, fix.id, { kind: "all" }, request);
    assert.ok(queued.ok, queued.ok ? "" : queued.error);
    assert.equal(queued.value.evalCount, 45);
    assert.equal((await store.listEvals(PROJECT, { statuses: ["suggested"] })).length, 45);
  } finally {
    await client.close();
  }
});

async function setup(flags: OrganizationFlagDeps = FLAGS_ON) {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  const original = buildFixes(fixesInput()).open.find((item) => item.source === "rewrite")!;
  const fix: Fix = {
    ...original,
    kind: "merge",
    subject: {
      ...original.subject,
      tasks: [{ id: "wf-1", label: "Seats", href: "", color: null }],
    },
  };
  await db.insert(fixDrafts).values({
    projectId: PROJECT,
    fixId: fix.id,
    change: MERGE,
    status: "ready",
    origin: "user",
    createdBy: "test",
  });
  const tracked: unknown[] = [];
  const request: RequestEvalSimulationDeps = {
    db,
    flagDeps: flags,
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (projectId) => ({
      project: { id: projectId },
      organization: { id: ORG },
    }),
    loadFix: async (_projectId, fixId) => (fixId === fix.id ? { projectId: PROJECT, fix } : null),
    track: async ({ runId, fixId, suite, evalCount }) => {
      tracked.push({ runId, fixId, suite, evalCount });
    },
  };
  return { client, db, request, tracked, fix };
}

function jobDeps(db: ReturnType<typeof getDb>): RunEvalSimulationDeps {
  const replays = new Map<string, EvalReplay>([
    [
      SEAT_TURN,
      recording(SEAT_TURN, "Pick seat 23A on R1", [
        { name: "get_seat_map", args: { ref: "R1" }, result: { free: ["23A"] } },
        { name: "select_seat", args: { ref: "R1", seat: "23A" }, result: { seat: "23A" } },
      ]),
    ],
    // The selection asks for another booking, so the merged call can't be answered from the recording.
    [
      SPLIT_TURN,
      recording(SPLIT_TURN, "Pick seat 23A on R1 for booking R9", [
        { name: "get_seat_map", args: { ref: "R1" }, result: { free: ["23A"] } },
        { name: "select_seat", args: { ref: "R9", seat: "23A" }, result: { seat: "23A" } },
      ]),
    ],
    [
      OTHER_TURN,
      recording(OTHER_TURN, "Show booking R1", [
        { name: "get_booking", args: { ref: "R1" }, result: { ref: "R1" } },
      ]),
    ],
  ]);
  return {
    db,
    flagDeps: FLAGS_ON,
    models: standInModels(),
    observability: { trackSystemEvent: async () => undefined },
    loadReplays: async (_projectId, turnIds) =>
      new Map(turnIds.flatMap((id) => (replays.has(id) ? [[id, replays.get(id)!] as const] : []))),
  };
}

/**
 * wf-1 (the fix's task) allows one tool call. Its evals: Strict (two calls
 * today, one with the merge), Expects (wants `select_seat` called, which the
 * merge replaces), Split (the merge's second half has no recording), Gone (no
 * recorded run). wf-other's eval uses no tool the fix touches.
 */
async function seedEvals(db: ReturnType<typeof getDb>) {
  await upsertScorer(
    {
      projectId: PROJECT,
      taskId: "wf-1",
      scorer: { kind: "max_tool_calls", max: 1 },
      updatedBy: "t",
    },
    db,
  );
  await upsertScorer(
    {
      projectId: PROJECT,
      taskId: "wf-other",
      scorer: { kind: "max_tool_calls", max: 3 },
      updatedBy: "t",
    },
    db,
  );
  const store = createDrizzleEvalStore(db);
  const base = {
    projectId: PROJECT,
    message: "Pick seat 23A on R1",
    origin: "user" as const,
    createdBy: "t",
    status: "approved" as const,
    tasks: ["wf-1"],
  };
  const strict = await store.createEval({ ...base, name: "Strict", sourceTurnId: SEAT_TURN });
  const expects = await store.createEval({
    ...base,
    name: "Expects",
    sourceTurnId: SEAT_TURN,
    expectedTool: "select_seat",
    checks: { max_tool_calls: { on: false } },
  });
  const split = await store.createEval({ ...base, name: "Split", sourceTurnId: SPLIT_TURN });
  const gone = await store.createEval({
    ...base,
    name: "Gone",
    sourceTurnId: "77777777-7777-4777-8777-777777777777",
  });
  const other = await store.createEval({
    ...base,
    name: "Other",
    sourceTurnId: OTHER_TURN,
    tasks: ["wf-other"],
  });
  await store.createEval({
    ...base,
    name: "Suggested",
    sourceTurnId: SEAT_TURN,
    status: "suggested",
  });
  await store.createEval({ ...base, name: "Removed", sourceTurnId: SEAT_TURN, status: "archived" });
  return {
    strict: strict.id,
    expects: expects.id,
    split: split.id,
    gone: gone.id,
    other: other.id,
  };
}

function recording(
  turnId: string,
  ask: string,
  steps: { name: string; args: Record<string, unknown>; result: unknown }[],
): EvalReplay {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, n));
  const payload = (messages: CloudMessage[], finish: CloudEvent["finish_reason"]): CloudEvent => ({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    ts: at(0).toISOString(),
    system: "You are a travel agent.",
    tools: [...new Set(steps.map(({ name }) => name))].map((name) => ({
      name,
      description: `${name} does its job.`,
      parameters: { type: "object", properties: {} },
    })),
    messages,
    finish_reason: finish,
  });
  const conversation: CloudMessage[] = [{ role: "user", content: [{ type: "text", text: ask }] }];
  const calls: ModelCall[] = [];
  steps.forEach((step, index) => {
    const output: CloudMessage = {
      role: "assistant",
      content: [{ type: "tool_call", id: `toolu_${index}`, name: step.name, arguments: step.args }],
    };
    calls.push({
      turnId,
      occurredAt: at(index * 2),
      model: "claude-sonnet-4-6",
      finishReason: "tool_call",
      costUsd: 0.003,
      latencyMs: 800,
      inputTokens: 900,
      outputTokens: 30,
      payload: payload([...conversation, output], "tool_call"),
    });
    conversation.push(output, {
      role: "tool",
      tool_call_id: `toolu_${index}`,
      content: JSON.stringify(step.result),
    });
  });
  const answer: CloudMessage = { role: "assistant", content: [{ type: "text", text: "Done." }] };
  calls.push({
    turnId,
    occurredAt: at(steps.length * 2),
    model: "claude-sonnet-4-6",
    finishReason: "stop",
    costUsd: 0.003,
    latencyMs: 800,
    inputTokens: 900,
    outputTokens: 30,
    payload: payload([...conversation, answer], "stop"),
  });
  const run: RunRecord = {
    turnId,
    traceId: `trace-${turnId}`,
    startedAt: at(0).toISOString(),
    endedAt: at(steps.length * 2).toISOString(),
    taskId: "wf-1",
    steps: steps.map((step, index) => ({
      kind: "invoke",
      ordinal: index + 1,
      targetId: step.name,
      outcome: "ok",
    })),
    durationMs: 4000,
    costUsd: 0.009,
    answered: true,
  };
  return { run, calls };
}
