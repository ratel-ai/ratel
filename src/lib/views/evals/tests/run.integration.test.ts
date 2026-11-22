import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { jobs } from "@/lib/jobs/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { OrganizationFlagDeps } from "@/lib/platform/organization-flags";
import { CANT_SIMULATE } from "@/lib/views/eval-gate/method";
import {
  type EvalModels,
  type ReplayMessage,
  scriptedAgent,
  standInModels,
} from "@/lib/views/eval-gate/models";
import { evalRuns, evals } from "@/lib/views/evals/schema";
import { sessionReplaySettings } from "@/lib/views/session-replay/schema";
import { upsertScorer } from "@/lib/views/task-scorers/store";
import { createDrizzleEvalStore } from "../adapters/drizzle-store";
import { earlierFromSteps } from "../domain/steps";
import {
  continueFromStepAs,
  editReplyAndRerunAs,
  type StepActionDeps,
  type StepActionEvent,
  simulateStepAgain,
} from "../edit";
import { EVALS_OFF_ERROR } from "../gate";
import { type EvalReplay, type RunEvalSetDeps, runEvalSetJob } from "../job";
import { type RequestEvalRunDeps, requestEvalRun } from "../run";
import { seatRecording, TURN } from "./seat-recording";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const GONE = "55555555-5555-4555-8555-555555555555";
const FLAGS_ON: OrganizationFlagDeps = {
  isConfigured: () => true,
  readOverride: () => undefined,
  evaluate: async () => true,
};
const FLAGS_OFF: OrganizationFlagDeps = { ...FLAGS_ON, evaluate: async () => false };
const NO_EVENTS = { trackSystemEvent: async () => undefined };

test("a manual run queues one run and its job, tracks it once, and a second click gets the same run", async () => {
  const { client, db, request, tracked } = await setup();
  try {
    await seedEvals(db);
    const first = await requestEvalRun(PROJECT, null, request);
    assert.ok(first.ok, first.ok ? "" : first.error);
    assert.equal(first.value.kind, "manual");
    assert.equal(
      first.value.evalCount,
      4,
      "Suggested evals run with the set; archived ones do not.",
    );
    const queued = await db.select().from(jobs);
    assert.deepEqual(
      queued.map((job) => [job.kind, (job.payload as { runId: string }).runId]),
      [["run_eval_set", first.value.id]],
    );
    const again = await requestEvalRun(PROJECT, null, request);
    assert.ok(again.ok);
    assert.equal(again.value.id, first.value.id);
    assert.equal((await db.select().from(jobs)).length, 1);
    assert.equal(tracked.length, 1);
  } finally {
    await client.close();
  }
});

test("flag off: the action refuses and no run or job is queued", async () => {
  const { client, db, request, tracked } = await setup(FLAGS_OFF);
  try {
    await seedEvals(db);
    const result = await requestEvalRun(PROJECT, null, request);
    assert.deepEqual(result, { ok: false, error: "Evals are off for this organization." });
    assert.equal((await db.select().from(evalRuns)).length, 0);
    assert.equal((await db.select().from(jobs)).length, 0);
    assert.equal(tracked.length, 0);
  } finally {
    await client.close();
  }
});

test("the job replays each eval as recorded, scores it with the stricter task limit and its override, and records the change", async () => {
  const { client, db, request } = await setup();
  try {
    await db.insert(sessionReplaySettings).values({ projectId: PROJECT, readContent: false });
    const { strict, loose } = await seedEvals(db);
    const store = createDrizzleEvalStore(db);
    const run = async () => {
      const queued = await requestEvalRun(PROJECT, null, request);
      assert.ok(queued.ok, queued.ok ? "" : queued.error);
      await runEvalSetJob(PROJECT, { runId: queued.value.id }, jobDeps(db));
      return {
        run: (await store.getRun(PROJECT, queued.value.id))!,
        results: new Map(
          (await store.listResults(PROJECT, queued.value.id)).map((r) => [r.evalId, r]),
        ),
      };
    };
    const first = await run();
    assert.equal(first.run.status, "completed");
    const strictResult = first.results.get(strict)!;
    assert.deepEqual(
      strictResult.verdicts.find((v) => v.kind === "max_tool_calls"),
      { kind: "max_tool_calls", status: "fail", measured: 2, limit: 1, detail: "2 calls" },
    );
    assert.equal(
      strictResult.verdicts.find((v) => v.kind === "max_latency_ms"),
      undefined,
      "Turned off on this eval.",
    );
    assert.equal(strictResult.passed, false);
    assert.equal(strictResult.change, "new");
    assert.deepEqual(
      strictResult.toolAnswers.map((a) => [a.tool, a.source, a.reason]),
      [
        ["get_seat_map", "recorded", "matched_recording"],
        ["select_seat", "recorded", "matched_recording"],
      ],
    );
    assert.ok(
      strictResult.transcript!.steps.length > 0,
      "RC-641: with the eval gate on, the text is kept whatever the content opt-in.",
    );
    const looseResult = first.results.get(loose)!;
    assert.equal(
      looseResult.verdicts.find((v) => v.kind === "max_tool_calls")!.status,
      "pass",
      "The eval's override (5) wins over the tasks' 1.",
    );
    assert.equal(looseResult.passed, true);
    const gone = first.results.get(
      (await store.listEvals(PROJECT)).find((e) => e.name === "Gone")!.id,
    )!;
    assert.deepEqual([gone.passed, gone.error], [null, "The recorded run is gone."]);

    await db
      .update(sessionReplaySettings)
      .set({ readContent: true })
      .where(eq(sessionReplaySettings.projectId, PROJECT));
    await db
      .update(evals)
      .set({ checks: { max_tool_calls: { on: true, max: 1 } } })
      .where(eq(evals.id, loose));
    const second = await run();
    assert.equal(second.results.get(strict)!.change, "same");
    assert.equal(second.results.get(loose)!.change, "now_fails");
    assert.ok(
      second.results.get(strict)!.transcript!.steps.length > 0,
      "Content opt-in on: the replay text is kept.",
    );
    assert.deepEqual(second.results.get(strict)!.transcript!.toolsOffered, [
      "get_seat_map",
      "select_seat",
    ]);
  } finally {
    await client.close();
  }
});

test("spend never passes the reservation, and the reservation never passes what the organization has left today", async () => {
  const { client, db, request } = await setup();
  try {
    await seedEvals(db);
    // Spent today by an earlier run: 9.97 of the 10 a day.
    await db.insert(evalRuns).values({
      projectId: PROJECT,
      kind: "nightly",
      status: "completed",
      createdBy: "t",
      spend: { usd: 9.97, reservedUsd: 1, reserved: false },
      finishedAt: new Date(),
    });
    const queued = await requestEvalRun(PROJECT, null, request);
    assert.ok(queued.ok);
    const priced: EvalModels = {
      ...standInModels(),
      agent: ({ recorded }) => scriptedAgent(recorded, "claude-sonnet-4-6"),
    };
    await runEvalSetJob(
      PROJECT,
      { runId: queued.value.id },
      { ...jobDeps(db), models: priced, runBudgetUsd: 1 },
    );
    const store = createDrizzleEvalStore(db);
    const run = (await store.getRun(PROJECT, queued.value.id))!;
    assert.ok(Math.abs(run.spend.reservedUsd - 0.03) < 1e-9, `reserved ${run.spend.reservedUsd}`);
    assert.ok(run.spend.usd <= run.spend.reservedUsd);
    assert.equal(run.spend.reserved, false);
    const results = await store.listResults(PROJECT, run.id);
    assert.ok(
      results.some((r) => r.error === CANT_SIMULATE.budget),
      "A replay the budget can't hold stops and says so.",
    );
  } finally {
    await client.close();
  }
});

test("RC-295: the job gives the eval's earlier messages as history and its fixed answers win over the recording", async () => {
  const { client, db, request } = await setup();
  try {
    const store = createDrizzleEvalStore(db);
    const mocked = await store.createEval({
      projectId: PROJECT,
      name: "Mocked",
      message: "Pick seat 23A on R1",
      origin: "user",
      createdBy: "t",
      status: "approved",
      sourceTurnId: TURN,
      earlierMessages: [
        { role: "user", text: "Hi, I'm Ana" },
        { role: "tool", text: '{"booking":"R1"}', tool: "find_booking", args: { ref: "R1" } },
      ],
      fixedAnswers: [
        { tool: "select_seat", result: { error: "seat taken" }, why: "Someone took 23A" },
      ],
    });
    const seen: number[] = [];
    const models: EvalModels = {
      ...standInModels(),
      agent: ({ recorded }) => {
        const agent = scriptedAgent(recorded);
        return {
          ...agent,
          next: async (input) => {
            seen.push(input.messages.length);
            return agent.next(input);
          },
        };
      },
    };
    const queued = await requestEvalRun(PROJECT, null, request);
    assert.ok(queued.ok, queued.ok ? "" : queued.error);
    await runEvalSetJob(PROJECT, { runId: queued.value.id }, { ...jobDeps(db), models });
    const [result] = (await store.listResults(PROJECT, queued.value.id)).filter(
      (r) => r.evalId === mocked.id,
    );
    assert.equal(
      seen[0],
      4,
      "Earlier: the person, the agent's call and its answer, then the recorded ask.",
    );
    assert.equal(result!.toolCalls, 2, "The earlier tool call is history, not a step.");
    assert.deepEqual(
      result!.toolAnswers.map((a) => [a.tool, a.source, a.reason, a.why ?? null]),
      [
        ["get_seat_map", "recorded", "matched_recording", null],
        ["select_seat", "mock", "fixed_answer", "Someone took 23A"],
      ],
    );
  } finally {
    await client.close();
  }
});

test("RC-296: an eval with a simulated person runs 3 times, and its turns and pass rate are kept", async () => {
  const { client, db, request } = await setup();
  try {
    await db.insert(sessionReplaySettings).values({ projectId: PROJECT, readContent: false });
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "wf-1",
        scorer: { kind: "max_tool_calls", max: 3 },
        updatedBy: "t",
      },
      db,
    );
    const store = createDrizzleEvalStore(db);
    const multi = await store.createEval({
      projectId: PROJECT,
      name: "Multi",
      message: "Pick seat 23A on R1",
      origin: "user",
      createdBy: "t",
      status: "approved",
      sourceTurnId: TURN,
      tasks: ["wf-1"],
      turns: [
        { kind: "message", text: "Is it a window?" },
        { kind: "person", description: "a traveler in a hurry" },
      ],
    });
    // A row from before RC-296 holds plain strings: fixed messages.
    await db
      .update(evals)
      .set({ turns: ["Is it a window?", { kind: "person", description: "a traveler in a hurry" }] })
      .where(eq(evals.id, multi.id));
    assert.deepEqual((await store.getEval(PROJECT, multi.id))!.turns[0], {
      kind: "message",
      text: "Is it a window?",
    });
    const queued = await requestEvalRun(PROJECT, null, request);
    assert.ok(queued.ok, queued.ok ? "" : queued.error);
    await runEvalSetJob(PROJECT, { runId: queued.value.id }, jobDeps(db));
    const [result] = (await store.listResults(PROJECT, queued.value.id)).filter(
      (r) => r.evalId === multi.id,
    );
    assert.equal(result!.error, null);
    assert.deepEqual(result!.attempts, { passed: 3, total: 3 });
    assert.deepEqual(
      result!.turns!.map((turn) => [turn.simulated, turn.passed]),
      [
        [false, true],
        [false, true],
        [true, true],
      ],
    );
    assert.deepEqual(
      result!.turns!.slice(0, 2).map((turn) => turn.message),
      ["Pick seat 23A on R1", "Is it a window?"],
      "RC-641: with the eval gate on, the words are kept whatever the content opt-in.",
    );
    assert.equal(result!.passed, true);
  } finally {
    await client.close();
  }
});

/* - fixtures ---------------------------------------------------------------- */

test("RC-609: an eval with a spec reaches a verdict with no captured prompts, unseen first-call IDs or no source run; without a spec each keeps its refusal", async () => {
  const { client, db, request } = await setup();
  try {
    await upsertScorer(
      {
        projectId: PROJECT,
        taskId: "wf-1",
        scorer: { kind: "max_tool_calls", max: 3 },
        updatedBy: "t",
      },
      db,
    );
    const store = createDrizzleEvalStore(db);
    const tool = {
      name: "hold_fare",
      description: "Hold a fare",
      parameters: { type: "object", properties: {} },
    };
    const spec = {
      systemPrompt: "You are a travel agent.",
      tools: [tool],
      context: { booking_ref: "MRD4F2K9" },
      generated: ["systemPrompt", "tools", "context"] as ("systemPrompt" | "tools" | "context")[],
    };
    const base = {
      projectId: PROJECT,
      message: "Hold my fare",
      origin: "user" as const,
      createdBy: "t",
      status: "approved" as const,
      tasks: ["wf-1"],
    };
    const BLANK = "66666666-6666-4666-8666-666666666666";
    const UNSEEN = "77777777-7777-4777-8777-777777777777";
    const made = {
      blank: await store.createEval({ ...base, name: "Blank", sourceTurnId: BLANK, ...spec }),
      unseen: await store.createEval({ ...base, name: "Unseen", sourceTurnId: UNSEEN, ...spec }),
      sourceless: await store.createEval({
        ...base,
        name: "Sourceless",
        sourceTurnId: null,
        ...spec,
      }),
      blankOld: await store.createEval({ ...base, name: "Blank, no spec", sourceTurnId: BLANK }),
      unseenOld: await store.createEval({ ...base, name: "Unseen, no spec", sourceTurnId: UNSEEN }),
      sourcelessOld: await store.createEval({
        ...base,
        name: "Sourceless, no spec",
        sourceTurnId: null,
      }),
    };
    const seat = seatRecording();
    const unseen = seatRecording({ ref: "MRD4F2K9" });
    const replays = new Map<string, EvalReplay>([
      [BLANK, { run: seat.run, calls: seat.calls.map((call) => ({ ...call, payload: null })) }],
      [UNSEEN, unseen],
    ]);
    const queued = await requestEvalRun(PROJECT, null, request);
    assert.ok(queued.ok, queued.ok ? "" : queued.error);
    await runEvalSetJob(
      PROJECT,
      { runId: queued.value.id },
      { ...jobDeps(db), loadReplays: async () => replays },
    );
    const results = new Map(
      (await store.listResults(PROJECT, queued.value.id)).map((r) => [r.evalId, r]),
    );
    for (const name of ["blank", "unseen", "sourceless"] as const) {
      const result = results.get(made[name].id)!;
      assert.equal(result.error, null, `${name}: ${result.error}`);
      assert.equal(typeof result.passed, "boolean", `${name} reaches a verdict`);
    }
    assert.deepEqual(
      results.get(made.sourceless.id)!.generated,
      ["systemPrompt", "tools", "context"],
      "The result names the generated inputs it used.",
    );
    assert.deepEqual(
      results.get(made.unseen.id)!.generated,
      ["context"],
      "The recording's prompt and tools win.",
    );
    assert.equal(results.get(made.blankOld.id)!.error, CANT_SIMULATE.noPrompts);
    assert.equal(results.get(made.unseenOld.id)!.error, CANT_SIMULATE.ungrounded);
    assert.equal(results.get(made.sourcelessOld.id)!.error, "The recorded run is gone.");
    assert.ok(
      !("generated" in results.get(made.blankOld.id)!),
      "A run without a spec reads as before.",
    );
  } finally {
    await client.close();
  }
});

test("RC-641: with the gate on and the content opt-in off, a run keeps its steps, and the prune clears them after 30 days", async () => {
  const { client, db, request } = await setup();
  try {
    await db.insert(sessionReplaySettings).values({ projectId: PROJECT, readContent: false });
    const item = await createDrizzleEvalStore(db).createEval({
      projectId: PROJECT,
      name: "Seat",
      message: "Pick seat 23A on R1",
      origin: "user",
      createdBy: "t",
      status: "approved",
      sourceTurnId: TURN,
    });
    const queued = await requestEvalRun(PROJECT, null, request);
    assert.ok(queued.ok, queued.ok ? "" : queued.error);
    await runEvalSetJob(PROJECT, { runId: queued.value.id }, jobDeps(db));
    const store = createDrizzleEvalStore(db);
    const [kept] = await store.listResults(PROJECT, queued.value.id);
    assert.equal(kept!.evalId, item.id);
    assert.ok(kept!.transcript!.steps.length > 0);
    assert.equal(
      await store.pruneTranscripts(new Date(kept!.createdAt.getTime() + 29 * 86_400_000)),
      0,
      "Kept for 30 days.",
    );
    assert.equal(
      await store.pruneTranscripts(new Date(kept!.createdAt.getTime() + 31 * 86_400_000)),
      1,
    );
    const [pruned] = await store.listResults(PROJECT, queued.value.id);
    assert.equal(pruned!.transcript, null);
    assert.equal(pruned!.passed, kept!.passed, "The verdict stays.");
  } finally {
    await client.close();
  }
});

test("RC-641: Simulate again at a tool step saves its answer as a fixed answer, and the new run answers that call with it", async () => {
  const { client, db, request } = await setup();
  try {
    const { item, runId, steps } = await seatRun(db, request);
    const selectStep = steps.findIndex(
      (step) => step.role === "tool" && step.tool === "select_seat",
    );
    const events: StepActionEvent[] = [];
    const again = await simulateStepAgain(
      PROJECT,
      { evalId: item.id, runId, step: selectStep },
      '{"error":"seat taken"}',
      stepDeps(db, events),
    );
    assert.ok(again.ok, again.ok ? "" : again.error);
    assert.deepEqual(again.value.item.fixedAnswers, [
      {
        tool: "select_seat",
        result: { error: "seat taken" },
        when: { ref: "R1", seat: "23A" },
        why: "Set at a step of a simulated run",
      },
    ]);
    assert.notEqual(again.value.run.id, runId);
    assert.equal(again.value.run.evalCount, 1);
    assert.deepEqual(
      events.map((event) => event.action),
      ["step_answer_set", "rerun"],
    );
    await runEvalSetJob(PROJECT, { runId: again.value.run.id, evalId: item.id }, jobDeps(db));
    const [result] = await createDrizzleEvalStore(db).listResults(PROJECT, again.value.run.id);
    assert.deepEqual(
      result!.toolAnswers.map((answer) => [answer.tool, answer.source]),
      [
        ["get_seat_map", "recorded"],
        ["select_seat", "mock"],
      ],
    );

    const notTool = await simulateStepAgain(
      PROJECT,
      { evalId: item.id, runId, step: 0 },
      "x",
      stepDeps(db, events),
    );
    assert.deepEqual(notTool, { ok: false, error: "Step 0 is not a tool answer." });
    const off = await simulateStepAgain(
      PROJECT,
      { evalId: item.id, runId, step: selectStep },
      "x",
      { ...stepDeps(db, events), flagDeps: FLAGS_OFF },
    );
    assert.deepEqual(off, { ok: false, error: EVALS_OFF_ERROR });
  } finally {
    await client.close();
  }
});

test("RC-641: Continue from step 2 saves a copy whose earlier messages are steps 0..2, and runs it", async () => {
  const { client, db, request } = await setup();
  try {
    const { item, runId, steps } = await seatRun(db, request);
    const events: StepActionEvent[] = [];
    const continued = await continueFromStepAs(
      PROJECT,
      { evalId: item.id, runId, step: 2 },
      stepDeps(db, events),
    );
    assert.ok(continued.ok, continued.ok ? "" : continued.error);
    const copy = (await createDrizzleEvalStore(db).getEval(PROJECT, continued.value.item.id))!;
    assert.notEqual(copy.id, item.id);
    assert.deepEqual(copy.earlierMessages, earlierFromSteps(steps, 2));
    assert.deepEqual(
      copy.earlierMessages,
      [{ role: "tool", tool: "get_seat_map", args: { ref: "R1" }, text: '{"free":["23A"]}' }],
      "The answered call of steps 0..2; the open select_seat call is decided again.",
    );
    assert.deepEqual(
      [copy.origin, copy.status, copy.message, copy.sourceTurnId, copy.name],
      ["user", "approved", item.message, TURN, "Seat (continued)"],
    );
    assert.equal(continued.value.run.evalCount, 1);
    assert.equal(events[0]!.action, "continued_from_step");
    await runEvalSetJob(PROJECT, { runId: continued.value.run.id, evalId: copy.id }, jobDeps(db));
    const [result] = await createDrizzleEvalStore(db).listResults(PROJECT, continued.value.run.id);
    assert.equal(result!.evalId, copy.id);
    const past = await continueFromStepAs(
      PROJECT,
      { evalId: item.id, runId, step: 99 },
      stepDeps(db, events),
    );
    assert.equal(past.ok, false);
  } finally {
    await client.close();
  }
});

test("RC-654: Edit reply at step 2 runs this eval from the edited reply, and the agent's first turn after it follows that reply", async () => {
  const { client, db, request } = await setup();
  try {
    const { item, runId, steps } = await seatRun(db, request);
    assert.equal(steps[2]!.role, "assistant");
    const reply = {
      text: "Let me take 12C instead.",
      calls: [{ name: "select_seat", args: { ref: "R1", seat: "12C" } }],
    };
    const events: StepActionEvent[] = [];
    const edited = await editReplyAndRerunAs(
      PROJECT,
      { evalId: item.id, runId, step: 2 },
      reply,
      "this",
      stepDeps(db, events),
    );
    assert.ok(edited.ok, edited.ok ? "" : edited.error);
    assert.equal(edited.value.item.id, item.id, "This eval, not a copy.");
    assert.deepEqual(edited.value.item.opening, [
      ...steps.slice(0, 2),
      { role: "assistant", ...reply },
    ]);
    assert.deepEqual(
      events.map((event) => event.action),
      ["reply_edited", "rerun"],
    );
    const seen: ReplayMessage[][] = [];
    const models: EvalModels = {
      ...standInModels(),
      agent: ({ recorded }) => {
        const agent = scriptedAgent(recorded);
        return {
          ...agent,
          next: async (input) => {
            seen.push([...input.messages]);
            return {
              text: "Seat 12C is yours.",
              calls: [],
              usage: { inputTokens: 1, outputTokens: 1 },
              latencyMs: 0,
              model: agent.model,
            };
          },
        };
      },
    };
    await runEvalSetJob(
      PROJECT,
      { runId: edited.value.run.id, evalId: item.id },
      { ...jobDeps(db), models },
    );
    assert.equal(seen.length, 1, "The agent is asked once, after the edited reply and its answer.");
    const [lastReply, answer] = seen[0]!.slice(-2);
    assert.deepEqual(
      lastReply && lastReply.role === "assistant"
        ? [lastReply.text, lastReply.calls.map(({ name, args }) => ({ name, args }))]
        : null,
      [reply.text, reply.calls],
    );
    assert.equal(answer!.role, "tool");
    const [result] = await createDrizzleEvalStore(db).listResults(PROJECT, edited.value.run.id);
    assert.deepEqual(
      result!.transcript!.steps.slice(0, 3),
      [...steps.slice(0, 2), { role: "assistant", ...reply }],
      "The new run starts with the steps before it and the edited reply.",
    );
    assert.deepEqual(result!.transcript!.steps.at(-1), {
      role: "assistant",
      text: "Seat 12C is yours.",
      calls: [],
    });
    assert.deepEqual(
      result!.toolAnswers.map((entry) => [entry.tool, entry.source]),
      [
        ["get_seat_map", "earlier"],
        ["select_seat", "stand-in"],
      ],
    );
  } finally {
    await client.close();
  }
});

test("RC-654: Edit reply on a copy keeps the eval as it was; a reply with no call ends the run; a tool step or the flag off is refused", async () => {
  const { client, db, request } = await setup();
  try {
    const { item, runId } = await seatRun(db, request);
    const events: StepActionEvent[] = [];
    const copied = await editReplyAndRerunAs(
      PROJECT,
      { evalId: item.id, runId, step: 2 },
      { text: "I can't change seats today.", calls: [] },
      "copy",
      stepDeps(db, events),
    );
    assert.ok(copied.ok, copied.ok ? "" : copied.error);
    assert.notEqual(copied.value.item.id, item.id);
    assert.equal(copied.value.item.name, "Seat (edited reply)");
    assert.equal(
      (await createDrizzleEvalStore(db).getEval(PROJECT, item.id))!.opening,
      undefined,
      "The original is unchanged.",
    );
    let asked = 0;
    const models: EvalModels = {
      ...standInModels(),
      agent: ({ recorded }) => ({
        ...scriptedAgent(recorded),
        next: async () => {
          asked += 1;
          throw new Error("not asked");
        },
      }),
    };
    await runEvalSetJob(
      PROJECT,
      { runId: copied.value.run.id, evalId: copied.value.item.id },
      { ...jobDeps(db), models },
    );
    const [result] = await createDrizzleEvalStore(db).listResults(PROJECT, copied.value.run.id);
    assert.equal(asked, 0, "A reply with no call ends the turn.");
    assert.equal(result!.error, null);
    assert.deepEqual(result!.transcript!.steps.at(-1), {
      role: "assistant",
      text: "I can't change seats today.",
      calls: [],
    });

    const tool = await editReplyAndRerunAs(
      PROJECT,
      { evalId: item.id, runId, step: 1 },
      { text: "x", calls: [] },
      "this",
      stepDeps(db, events),
    );
    assert.deepEqual(tool, { ok: false, error: "Step 1 is not an agent reply." });
    const empty = await editReplyAndRerunAs(
      PROJECT,
      { evalId: item.id, runId, step: 2 },
      { text: " ", calls: [] },
      "this",
      stepDeps(db, events),
    );
    assert.deepEqual(empty, { ok: false, error: "Write the reply, or add a call." });
    const off = await editReplyAndRerunAs(
      PROJECT,
      { evalId: item.id, runId, step: 2 },
      { text: "x", calls: [] },
      "this",
      { ...stepDeps(db, events), flagDeps: FLAGS_OFF },
    );
    assert.deepEqual(off, { ok: false, error: EVALS_OFF_ERROR });
  } finally {
    await client.close();
  }
});

/** One eval of the seat recording, run once with its steps kept. */
async function seatRun(db: ReturnType<typeof getDb>, request: RequestEvalRunDeps) {
  const item = await createDrizzleEvalStore(db).createEval({
    projectId: PROJECT,
    name: "Seat",
    message: "Pick seat 23A on R1",
    origin: "user",
    createdBy: "t",
    status: "approved",
    sourceTurnId: TURN,
  });
  const queued = await requestEvalRun(PROJECT, null, request);
  assert.ok(queued.ok, queued.ok ? "" : queued.error);
  await runEvalSetJob(PROJECT, { runId: queued.value.id }, jobDeps(db));
  const [result] = await createDrizzleEvalStore(db).listResults(PROJECT, queued.value.id);
  return { item, runId: queued.value.id, steps: result!.transcript!.steps };
}

function stepDeps(db: ReturnType<typeof getDb>, events: StepActionEvent[]): StepActionDeps {
  return {
    db,
    flagDeps: FLAGS_ON,
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (projectId) => ({
      project: { id: projectId },
      organization: { id: ORG },
    }),
    track: async (event) => {
      events.push(event);
    },
  };
}

async function setup(flags: OrganizationFlagDeps = FLAGS_ON) {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Test', 'test');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  const tracked: unknown[] = [];
  const request: RequestEvalRunDeps = {
    db,
    flagDeps: flags,
    getSession: async () => ({ user: { id: "u1", externalId: "user_1" } }),
    findProjectScope: async (projectId) => ({
      project: { id: projectId },
      organization: { id: ORG },
    }),
    track: async (event) => {
      tracked.push(event);
    },
  };
  return { client, db, request, tracked };
}

function jobDeps(db: ReturnType<typeof getDb>): RunEvalSetDeps {
  const recorded = seatRecording();
  return {
    db,
    flagDeps: FLAGS_ON,
    models: standInModels(),
    observability: NO_EVENTS,
    loadReplays: async (_projectId, turnIds) =>
      new Map<string, EvalReplay>(turnIds.filter((id) => id === TURN).map((id) => [id, recorded])),
  };
}

/** Two tasks (tool-call limits 3 and 1: the stricter is 1), two approved evals of both, one approved eval whose run is gone, one suggestion, one archived eval. */
async function seedEvals(db: ReturnType<typeof getDb>) {
  await upsertScorer(
    {
      projectId: PROJECT,
      taskId: "wf-1",
      scorer: { kind: "max_tool_calls", max: 3 },
      updatedBy: "t",
    },
    db,
  );
  await upsertScorer(
    {
      projectId: PROJECT,
      taskId: "wf-2",
      scorer: { kind: "max_tool_calls", max: 1 },
      updatedBy: "t",
    },
    db,
  );
  await upsertScorer(
    {
      projectId: PROJECT,
      taskId: "wf-2",
      scorer: { kind: "max_latency_ms", max: 1 },
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
    tasks: ["wf-1", "wf-2"],
  };
  const strict = await store.createEval({
    ...base,
    name: "Strict",
    sourceTurnId: TURN,
    checks: { max_latency_ms: { on: false } },
  });
  const loose = await store.createEval({
    ...base,
    name: "Loose",
    sourceTurnId: TURN,
    checks: { max_tool_calls: { on: true, max: 5 }, max_latency_ms: { on: false } },
  });
  await store.createEval({ ...base, name: "Gone", sourceTurnId: GONE });
  await store.createEval({ ...base, name: "Suggested", sourceTurnId: TURN, status: "suggested" });
  await store.createEval({ ...base, name: "Removed", sourceTurnId: TURN, status: "archived" });
  return { strict: strict.id, loose: loose.id };
}
