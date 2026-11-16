import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudEvent, CloudMessage } from "@/lib/ingest/cloud-schema";
import type { ModelCall } from "@/lib/views/eval-gate/calls";
import { emptyChange } from "@/lib/views/eval-gate/change";
import { CANT_SIMULATE } from "@/lib/views/eval-gate/method";
import {
  type AgentModel,
  type EvalModels,
  ModelRefused,
  type ReplayMessage,
  SpendMeter,
} from "@/lib/views/eval-gate/models";
import type { Ranker } from "@/lib/views/eval-gate/simulate";
import type { FixChange, RunRecord, RunStep, ToolDef } from "@/lib/views/eval-gate/types";
import {
  carriesText,
  forkInput,
  NO_TOOL,
  recordingAt,
  type SampleDeps,
  sampleStep,
  variantBuiltFields,
} from "./fork";
import { rerankChange, type Variant, variantKey } from "./variant";

/* - fixtures ------------------------------------------------------------------ */

const MODEL = "claude-sonnet-4-6";
const def = (name: string): ToolDef => ({
  name,
  description: `${name} does its job.`,
  parameters: { type: "object", properties: { ref: { type: "string" } } },
});
const callBlock = (id: string, name: string) => ({
  type: "tool_call" as const,
  id,
  name,
  arguments: { ref: "R1" },
});
const result = (id: string, content: unknown): CloudMessage => ({
  role: "tool",
  tool_call_id: id,
  content: JSON.stringify(content),
});

/** A run that called `steps` in order, then answered: one model call per decision, each payload its input plus its output. */
function recordedRun(
  steps: string[],
  offered: string[],
  options: { captured?: boolean } = {},
): { run: RunRecord; calls: ModelCall[] } {
  const at = (n: number) => new Date(Date.UTC(2026, 10, 2, 12, 0, n));
  const payload = (messages: CloudMessage[]): CloudEvent => ({
    provider: "anthropic",
    model: MODEL,
    ts: at(0).toISOString(),
    system: "You are a travel agent.",
    tools: offered.map(def),
    messages,
    finish_reason: "tool_call",
  });
  const conversation: CloudMessage[] = [
    { role: "user", content: [{ type: "text", text: "Hold the fare for booking R1" }] },
  ];
  const calls: ModelCall[] = [];
  const record = (index: number, output: CloudMessage) =>
    calls.push({
      turnId: "t1",
      occurredAt: at(index),
      model: MODEL,
      finishReason: "tool_call",
      costUsd: 0.003,
      latencyMs: 800,
      inputTokens: 900 + index * 100,
      outputTokens: 30,
      payload: options.captured === false ? null : payload([...conversation, output]),
    });
  steps.forEach((name, index) => {
    const id = `toolu_${index}`;
    const output: CloudMessage = { role: "assistant", content: [callBlock(id, name)] };
    record(index, output);
    conversation.push(output, result(id, { ok: name }));
  });
  record(steps.length, { role: "assistant", content: [{ type: "text", text: "All done." }] });
  const runSteps: RunStep[] = [
    { kind: "search", ordinal: 0, query: "hold a fare", hitIds: offered, topK: 5 },
    ...steps.map(
      (name, index): RunStep => ({
        kind: "invoke",
        ordinal: index + 1,
        targetId: name,
        outcome: "ok",
      }),
    ),
  ];
  return {
    run: {
      turnId: "t1",
      traceId: "trace-1",
      startedAt: at(0).toISOString(),
      taskId: null,
      steps: runSteps,
      durationMs: 10_000,
      costUsd: 0.01,
    },
    calls,
  };
}

/** A fake model that picks tools from a script, one per sample, and records what it was offered. */
function fakeModels(
  picks: (string | null)[],
  seen: { tools: string[]; messages: number }[] = [],
): EvalModels {
  let i = 0;
  const agent: AgentModel = {
    model: MODEL,
    standIn: false,
    async next({ tools, messages }) {
      seen.push({ tools: tools.map((tool) => tool.name), messages: messages.length });
      const pick = picks[i++ % picks.length] ?? null;
      return {
        text: pick ? "" : "Done.",
        calls: pick ? [{ id: `c${i}`, name: pick, args: {} }] : [],
        usage: { inputTokens: 1_000, outputTokens: 20 },
        latencyMs: 5,
        model: MODEL,
      };
    },
  };
  return { agent: () => agent, tool: null, judge: null, standIn: false };
}

function deps(over: Partial<SampleDeps> = {}): SampleDeps {
  return {
    models: fakeModels(["find_booking"]),
    spend: new SpendMeter(5),
    k: 3,
    toolDefs: new Map(),
    rank: null,
    ...over,
  };
}

const TOOLS = ["find_booking", "hold_fare", "cancel_fare"];

/* - recordingAt ----------------------------------------------------------------- */

test("recordingAt: the window model call N saw, and the tool it chose", () => {
  const { run, calls } = recordedRun(["find_booking", "hold_fare"], TOOLS);
  const step = recordingAt(calls, 1, run);
  assert.ok(step);
  // The ask, the first call and its result: what call 1 was given.
  assert.deepEqual(
    step.recording.history.map((message: ReplayMessage) => message.role),
    ["user", "assistant", "tool"],
  );
  assert.equal(step.recorded, "hold_fare");
  assert.deepEqual(
    step.recording.calls.map((call) => call.name),
    ["hold_fare"],
  );
  assert.equal(step.recording.system, "You are a travel agent.");
  assert.deepEqual(
    step.recording.tools.map((tool) => tool.name),
    TOOLS,
  );
});

test("recordingAt: call 0 sees only the ask; the last call chose to answer", () => {
  const { run, calls } = recordedRun(["find_booking", "hold_fare"], TOOLS);
  assert.equal(recordingAt(calls, 0, run)?.recording.history.length, 1);
  assert.equal(recordingAt(calls, 0, run)?.recorded, "find_booking");
  assert.equal(recordingAt(calls, 2, run)?.recorded, null);
});

test("recordingAt: null without captured content or out of range", () => {
  const { run, calls } = recordedRun(["find_booking"], TOOLS, { captured: false });
  assert.equal(recordingAt(calls, 0, run), null);
  assert.equal(recordingAt(recordedRun(["find_booking"], TOOLS).calls, 5), null);
});

/* - forkInput ------------------------------------------------------------------- */

function step1() {
  const { run, calls } = recordedRun(["find_booking", "hold_fare"], TOOLS);
  return recordingAt(calls, 1, run)!.recording;
}

test("forkInput: adds a tool", () => {
  const input = forkInput(step1(), { kind: "add_tool", tool: def("quote_fare") }, new Map());
  assert.deepEqual(
    input.tools.map((tool) => tool.name),
    [...TOOLS, "quote_fare"],
  );
  assert.equal(input.touched, true);
});

test("forkInput: removes a tool, and touches nothing when it wasn't offered", () => {
  const input = forkInput(step1(), { kind: "remove_tool", tool: "cancel_fare" }, new Map());
  assert.deepEqual(
    input.tools.map((tool) => tool.name),
    ["find_booking", "hold_fare"],
  );
  assert.equal(input.touched, true);
  assert.equal(forkInput(step1(), { kind: "remove_tool", tool: "nope" }, new Map()).touched, false);
});

test("forkInput: a tuned definition replaces the tool's description and schema", () => {
  const tuned: ToolDef = {
    name: "hold_fare",
    description: "Holds a fare for 24h.",
    parameters: { type: "object", properties: { booking: { type: "string" } } },
  };
  const input = forkInput(step1(), { kind: "definition", tool: tuned }, new Map());
  assert.deepEqual(
    input.tools.find((tool) => tool.name === "hold_fare"),
    tuned,
  );
  assert.equal(input.touched, true);
});

test("forkInput: a catalog override replaces the description the model reads, keeps the schema", () => {
  const input = forkInput(
    step1(),
    { kind: "catalog_override", tool: "hold_fare", searchable: "Reserve a fare." },
    new Map(),
  );
  const tool = input.tools.find((item) => item.name === "hold_fare")!;
  assert.equal(tool.description, "Reserve a fare.");
  assert.deepEqual(tool.parameters, def("hold_fare").parameters);
});

test("forkInput: a tool craft merges its sources through replayInput", () => {
  const input = forkInput(
    step1(),
    {
      kind: "tool_craft",
      tools: [{ ...def("book_and_hold"), replaces: ["find_booking", "hold_fare"] }],
    },
    new Map(),
  );
  assert.deepEqual(input.tools.map((tool) => tool.name).sort(), ["book_and_hold", "cancel_fare"]);
  assert.deepEqual([...input.merged.entries()], [["book_and_hold", ["find_booking", "hold_fare"]]]);
});

test("forkInput: a fix change goes through replayInput unchanged", () => {
  const change: FixChange = {
    ...emptyChange(),
    replay: { tools: [], failClearly: ["hold_fare"], prerequisite: null, skill: null },
  };
  const input = forkInput(step1(), { kind: "fix", change }, new Map());
  assert.notEqual(
    input.tools.find((tool) => tool.name === "hold_fare")!.description,
    def("hold_fare").description,
  );
  assert.deepEqual([...input.failClearly], ["hold_fare"]);
  assert.equal(input.touched, true);
});

/* - sampleStep ------------------------------------------------------------------ */

test("sampleStep: k samples per side, the old and new choice, the distribution, tokens and cost per side", async () => {
  const { run, calls } = recordedRun(["find_booking", "hold_fare"], TOOLS);
  const seen: { tools: string[]; messages: number }[] = [];
  // Control: hold_fare ×3. Variant: quote_fare, quote_fare, null.
  const models = fakeModels(
    ["hold_fare", "hold_fare", "hold_fare", "quote_fare", "quote_fare", null],
    seen,
  );
  const sample = await sampleStep(
    run,
    calls,
    1,
    { kind: "add_tool", tool: def("quote_fare") },
    deps({ models }),
  );
  assert.ok(sample.ok);
  assert.equal(sample.method, "replay");
  assert.equal(sample.k, 3);
  assert.equal(sample.recorded, "hold_fare");
  assert.deepEqual(sample.before.distribution, { hold_fare: 3 });
  assert.equal(sample.before.choice, "hold_fare");
  assert.deepEqual(sample.after.distribution, { quote_fare: 2, [NO_TOOL]: 1 });
  assert.equal(sample.after.choice, "quote_fare");
  assert.equal(sample.before.inputTokens, 3_000);
  assert.equal(sample.after.inputTokens, 3_000);
  assert.ok(sample.before.costUsd !== null && sample.before.costUsd > 0);
  assert.equal(sample.note, null);
  // One model call per sample, each with the window call 1 saw; the variant side is offered the new tool.
  assert.equal(seen.length, 6);
  assert.ok(seen.every((call) => call.messages === 3));
  assert.ok(!seen[0]!.tools.includes("quote_fare"));
  assert.ok(seen[3]!.tools.includes("quote_fare"));
});

test("sampleStep: the spend meter bounds every sample", async () => {
  const { run, calls } = recordedRun(["find_booking"], TOOLS);
  const spend = new SpendMeter(0.000_001);
  const sample = await sampleStep(
    run,
    calls,
    0,
    { kind: "add_tool", tool: def("quote_fare") },
    deps({ spend }),
  );
  assert.deepEqual(sample, { ok: false, reason: CANT_SIMULATE.budget });
  assert.equal(spend.calls, 0);
});

test("sampleStep: a refused key stops it", async () => {
  const { run, calls } = recordedRun(["find_booking"], TOOLS);
  const agent: AgentModel = {
    model: MODEL,
    standIn: false,
    next: async () => {
      throw new ModelRefused();
    },
  };
  const sample = await sampleStep(
    run,
    calls,
    0,
    { kind: "add_tool", tool: def("quote_fare") },
    deps({ models: { agent: () => agent, tool: null, judge: null, standIn: false } }),
  );
  assert.deepEqual(sample, { ok: false, reason: CANT_SIMULATE.refused });
});

test("sampleStep: a change that touches nothing the step saw says so", async () => {
  const { run, calls } = recordedRun(["find_booking"], TOOLS);
  const sample = await sampleStep(run, calls, 0, { kind: "remove_tool", tool: "nope" }, deps());
  assert.equal(sample.ok, false);
  assert.ok(!sample.ok && sample.notAffected);
});

test("sampleStep: k is clamped to 1..10", async () => {
  const { run, calls } = recordedRun(["find_booking"], TOOLS);
  const sample = await sampleStep(
    run,
    calls,
    0,
    { kind: "add_tool", tool: def("quote_fare") },
    deps({ k: 50 }),
  );
  assert.ok(sample.ok && sample.k === 10);
});

test("sampleStep: without captured content it re-ranks the step's search and says so", async () => {
  const { run, calls } = recordedRun(["find_booking", "hold_fare"], TOOLS, { captured: false });
  const changes: FixChange[] = [];
  const ranker = (change: FixChange): Ranker => {
    changes.push(change);
    return {
      before: () => ["find_booking", "hold_fare"],
      after: () => ["quote_fare", "find_booking"],
    };
  };
  const variant: Variant = { kind: "add_tool", tool: def("quote_fare") };
  const sample = await sampleStep(run, calls, 1, variant, deps({ rank: ranker }));
  assert.ok(sample.ok);
  assert.equal(sample.method, "rerank");
  assert.match(sample.note ?? "", /re-ranked/i);
  assert.equal(sample.recorded, "hold_fare");
  assert.equal(sample.before.choice, "hold_fare");
  assert.equal(sample.after.choice, "quote_fare");
  assert.deepEqual(sample.after.distribution, { quote_fare: 1 });
  assert.equal(sample.after.inputTokens, 0);
  assert.equal(sample.after.costUsd, 0);
  assert.deepEqual(changes, [rerankChange(variant)]);
});

test("sampleStep: without content and without a ranker it can't simulate", async () => {
  const { run, calls } = recordedRun(["find_booking"], TOOLS, { captured: false });
  assert.deepEqual(
    await sampleStep(run, calls, 0, { kind: "add_tool", tool: def("quote_fare") }, deps()),
    { ok: false, reason: CANT_SIMULATE.noPrompts },
  );
});

test("recordingAt: a call whose messages hold no text has nothing to replay", () => {
  const { run, calls } = recordedRun(["hold_fare"], ["hold_fare"]);
  const hollow = calls.map((call) => ({
    ...call,
    payload: {
      ...call.payload!,
      system: "",
      messages: [
        { role: "user", content: "" },
        { role: "assistant", content: [callBlock("toolu_0", "hold_fare")] },
      ] as CloudMessage[],
    },
  }));
  assert.equal(recordingAt(hollow, 0, run), null);
});

test("sampleStep: a call whose messages hold no text is re-ranked, not replayed", async () => {
  const { run, calls } = recordedRun(["hold_fare"], ["hold_fare"]);
  const hollow = calls.map((call) => ({
    ...call,
    payload: {
      ...call.payload!,
      system: "",
      messages: [
        { role: "user", content: "" },
        { role: "assistant", content: [callBlock("toolu_0", "hold_fare")] },
      ] as CloudMessage[],
    },
  }));
  const sample = await sampleStep(
    run,
    hollow,
    0,
    { kind: "remove_tool", tool: "hold_fare" },
    deps({ rank: () => ({ before: () => ["hold_fare"], after: () => [] }) }),
  );
  assert.ok(sample.ok);
  assert.equal(sample.method, "rerank");
});

test("carriesText: the same answer as the timeline's content check", () => {
  const payload = (fields: Partial<CloudEvent>): CloudEvent => ({
    provider: "anthropic",
    model: MODEL,
    ts: "2026-11-02T12:00:00.000Z",
    system: "",
    tools: [],
    messages: [],
    finish_reason: "tool_call",
    ...fields,
  });
  assert.equal(carriesText(payload({ system: "You help." })), true);
  assert.equal(carriesText(payload({ messages: [{ role: "user", content: "Hello" }] })), true);
  assert.equal(
    carriesText(
      payload({ messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }),
    ),
    true,
  );
  assert.equal(carriesText(payload({ messages: [{ role: "user", content: "" }] })), false);
  assert.equal(
    carriesText(payload({ messages: [{ role: "assistant", content: [callBlock("t", "a")] }] })),
    false,
  );
  assert.equal(
    carriesText(payload({ messages: [{ role: "user", content: [{ type: "text", text: "" }] }] })),
    false,
  );
});

/* - sampleStep: which tool call a model call made, by time ---------------------- */

const atSecond = (second: number) => new Date(Date.UTC(2026, 10, 2, 12, 0, second));
const timedCall = (second: number): ModelCall => ({
  turnId: "t1",
  occurredAt: atSecond(second),
  model: MODEL,
  finishReason: "tool_call",
  costUsd: 0.003,
  latencyMs: 800,
  inputTokens: 900,
  outputTokens: 30,
  payload: null,
});
const timedSearch = (
  ordinal: number,
  second: number | null,
  query: string,
  searchType?: string,
): RunStep => ({
  kind: "search",
  ordinal,
  query,
  hitIds: null,
  topK: 5,
  searchType,
  ...(second === null ? {} : { occurredAt: atSecond(second).toISOString() }),
});
const timedInvoke = (ordinal: number, second: number | null, targetId: string): RunStep => ({
  kind: "invoke",
  ordinal,
  targetId,
  outcome: "ok",
  ...(second === null ? {} : { occurredAt: atSecond(second).toISOString() }),
});
const timedRun = (steps: RunStep[]): RunRecord => ({
  turnId: "t1",
  traceId: "trace-1",
  startedAt: atSecond(0).toISOString(),
  taskId: null,
  steps,
});

/** Re-ranks model call `n` and reads which search the ranker was asked about. */
async function rerankAt(
  run: RunRecord,
  calls: ModelCall[],
  n: number,
): Promise<{ recorded: string | null; query: string | null }> {
  let query: string | null = null;
  const sample = await sampleStep(
    run,
    calls,
    n,
    { kind: "remove_tool", tool: "A" },
    deps({
      rank: () => ({
        before: (asked) => {
          query = asked;
          return [asked];
        },
        after: (asked) => [asked],
      }),
      models: { agent: null, tool: null, judge: null, standIn: false },
    }),
  );
  assert.ok(sample.ok);
  assert.equal(sample.method, "rerank");
  return { recorded: sample.recorded, query };
}

/** Call 0 at 0s made A and B, call 1 at 10s made C. */
const parallelRun = () =>
  timedRun([
    timedSearch(1, 1, "q1"),
    timedInvoke(2, 2, "A"),
    timedSearch(3, 3, "q2"),
    timedInvoke(4, 4, "B"),
    timedSearch(5, 11, "q3"),
    timedInvoke(6, 12, "C"),
  ]);

test("sampleStep rerank: a model call that made two tool calls doesn't shift the next call", async () => {
  assert.deepEqual(await rerankAt(parallelRun(), [timedCall(0), timedCall(10)], 1), {
    recorded: "C",
    query: "q3",
  });
});

test("sampleStep rerank: the fork is the call's first tool call, with the search before it", async () => {
  assert.deepEqual(await rerankAt(parallelRun(), [timedCall(0), timedCall(10)], 0), {
    recorded: "A",
    query: "q1",
  });
});

test("sampleStep rerank: a call without a tool call records none, and takes the last search before the next call", async () => {
  const run = timedRun([
    timedSearch(1, 1, "q1"),
    timedInvoke(2, 2, "A"),
    timedSearch(3, 11, "q2"),
    timedSearch(4, 21, "q3"),
    timedInvoke(5, 22, "B"),
  ]);
  assert.deepEqual(await rerankAt(run, [timedCall(0), timedCall(10), timedCall(20)], 1), {
    recorded: null,
    query: "q2",
  });
});

test("sampleStep rerank: the last call without a tool call takes the run's last search", async () => {
  const run = timedRun([timedSearch(1, 1, "q1"), timedInvoke(2, 2, "A"), timedSearch(3, 11, "q2")]);
  assert.deepEqual(await rerankAt(run, [timedCall(0), timedCall(10)], 1), {
    recorded: null,
    query: "q2",
  });
});

test("sampleStep rerank: a tool call at a call's time is that call's, not the one before", async () => {
  const run = timedRun([timedSearch(1, 1, "q1"), timedInvoke(2, 10, "A")]);
  const calls = [timedCall(0), timedCall(10)];
  assert.deepEqual(await rerankAt(run, calls, 0), { recorded: null, query: "q1" });
  assert.deepEqual(await rerankAt(run, calls, 1), { recorded: "A", query: "q1" });
});

test("sampleStep rerank: a skill search is never the fork's search, with times", async () => {
  const run = timedRun([
    timedSearch(1, 1, "q1"),
    timedSearch(2, 2, "skills", "skill_search"),
    timedInvoke(3, 3, "A"),
  ]);
  assert.deepEqual(await rerankAt(run, [timedCall(0)], 0), { recorded: "A", query: "q1" });
});

test("sampleStep rerank: without times on every step it stays index-based", async () => {
  const untimed = timedRun([
    timedSearch(1, null, "q1"),
    timedInvoke(2, null, "A"),
    timedSearch(3, null, "q2"),
    timedInvoke(4, null, "B"),
    timedSearch(5, null, "q3"),
    timedInvoke(6, null, "C"),
  ]);
  assert.deepEqual(await rerankAt(untimed, [timedCall(0), timedCall(10)], 1), {
    recorded: "B",
    query: "q2",
  });
  const partly = timedRun([
    timedSearch(1, 1, "q1"),
    timedInvoke(2, null, "A"),
    timedSearch(3, 3, "q2"),
    timedInvoke(4, 4, "B"),
    timedSearch(5, 11, "q3"),
    timedInvoke(6, 12, "C"),
  ]);
  assert.deepEqual(await rerankAt(partly, [timedCall(0), timedCall(10)], 1), {
    recorded: "B",
    query: "q2",
  });
});

test("sampleStep rerank: without the model call it stays index-based", async () => {
  assert.deepEqual(await rerankAt(parallelRun(), [], 1), { recorded: "B", query: "q2" });
});

test("sampleStep rerank: a call whose first tool call came before any search takes the search it made next", async () => {
  const run = timedRun([timedInvoke(1, 1, "A"), timedSearch(2, 2, "q1"), timedInvoke(3, 3, "B")]);
  assert.deepEqual(await rerankAt(run, [timedCall(0), timedCall(10)], 0), {
    recorded: "A",
    query: "q1",
  });
});

test("sampleStep rerank: a call without a search never borrows the next call's", async () => {
  const run = timedRun([timedInvoke(1, 1, "A"), timedSearch(2, 11, "q1"), timedInvoke(3, 12, "B")]);
  const sample = await sampleStep(
    run,
    [timedCall(0), timedCall(10)],
    0,
    { kind: "remove_tool", tool: "A" },
    deps({
      rank: () => ({ before: (query) => [query], after: (query) => [query] }),
      models: { agent: null, tool: null, judge: null, standIn: false },
    }),
  );
  assert.deepEqual(sample, { ok: false, reason: CANT_SIMULATE.noSearch });
});

test("sampleStep rerank: a run with no search says so, not that prompts are missing", async () => {
  const run = timedRun([timedInvoke(1, 1, "A")]);
  const sample = await sampleStep(
    run,
    [timedCall(0)],
    0,
    { kind: "remove_tool", tool: "A" },
    deps({
      rank: () => ({ before: (query) => [query], after: (query) => [query] }),
      models: { agent: null, tool: null, judge: null, standIn: false },
    }),
  );
  assert.deepEqual(sample, { ok: false, reason: CANT_SIMULATE.noSearch });
});

/* - sampleStep: the re-rank's baseline is the run ---------------------------------- */

const noModels = { agent: null, tool: null, judge: null, standIn: false };
const hitSearch = (ordinal: number, hitIds: string[] | null): RunStep => ({
  kind: "search",
  ordinal,
  query: "find it",
  hitIds,
  topK: 5,
});
const invoke = (ordinal: number, targetId: string): RunStep => ({
  kind: "invoke",
  ordinal,
  targetId,
  outcome: "ok",
});
const baselineRun = (hitIds: string[] | null, tool = "search_docs") =>
  timedRun([hitSearch(1, hitIds), invoke(2, tool)]);
async function rerankSides(
  run: RunRecord,
  variant: Variant,
  before: string[],
  after: string[],
): Promise<{ recorded: string | null; before: string | null; after: string | null }> {
  const sample = await sampleStep(
    run,
    [],
    0,
    variant,
    deps({ rank: () => ({ before: () => before, after: () => after }), models: noModels }),
  );
  assert.ok(sample.ok);
  return { recorded: sample.recorded, before: sample.before.choice, after: sample.after.choice };
}
const OVERRIDE: Variant = {
  kind: "catalog_override",
  tool: "get_trace",
  searchable: "Fetch a trace.",
};

test("re-rank baseline: before is the tool the run recorded, not the catalog's top hit", async () => {
  assert.deepEqual(
    await rerankSides(
      baselineRun(["search_docs", "get_trace"]),
      OVERRIDE,
      ["sentry_search_issues", "get_trace", "search_docs"],
      ["sentry_search_issues", "get_trace", "search_docs"],
    ),
    { recorded: "search_docs", before: "search_docs", after: "search_docs" },
  );
});

test("re-rank baseline: a change that doesn't move the ranker leaves the recorded tool", async () => {
  assert.deepEqual(
    await rerankSides(
      baselineRun(["get_trace", "search_docs"]),
      OVERRIDE,
      ["get_trace", "search_docs"],
      ["get_trace", "search_docs"],
    ),
    { recorded: "search_docs", before: "search_docs", after: "search_docs" },
  );
});

test("re-rank baseline: a change that moves the top hit among the served tools shows the new tool", async () => {
  assert.deepEqual(
    await rerankSides(
      baselineRun(["search_docs", "get_trace"]),
      OVERRIDE,
      ["search_docs", "get_trace"],
      ["get_trace", "search_docs"],
    ),
    { recorded: "search_docs", before: "search_docs", after: "get_trace" },
  );
});

test("re-rank baseline: a catalog tool the agent wasn't served can't win", async () => {
  assert.deepEqual(
    await rerankSides(
      baselineRun(["search_docs", "get_trace"]),
      OVERRIDE,
      ["search_docs", "other_tool", "get_trace"],
      ["other_tool", "search_docs", "get_trace"],
    ),
    { recorded: "search_docs", before: "search_docs", after: "search_docs" },
  );
});

test("re-rank baseline: a tool the change adds can win", async () => {
  assert.deepEqual(
    await rerankSides(
      baselineRun(["search_docs"]),
      { kind: "add_tool", tool: def("quote_fare") },
      ["search_docs"],
      ["quote_fare", "search_docs"],
    ),
    { recorded: "search_docs", before: "search_docs", after: "quote_fare" },
  );
});

test("re-rank baseline: removing the recorded tool moves to the next served tool", async () => {
  assert.deepEqual(
    await rerankSides(
      baselineRun(["get_trace", "search_docs"]),
      { kind: "remove_tool", tool: "search_docs" },
      ["get_trace", "search_docs"],
      ["get_trace"],
    ),
    { recorded: "search_docs", before: "search_docs", after: "get_trace" },
  );
});

test("re-rank baseline: without a served list it ranks the whole catalog", async () => {
  assert.deepEqual(
    await rerankSides(
      baselineRun(null),
      OVERRIDE,
      ["other_tool", "search_docs"],
      ["get_trace", "other_tool"],
    ),
    { recorded: "search_docs", before: "search_docs", after: "get_trace" },
  );
});

test("re-rank baseline: a call that made no tool call compares the ranker's top hits", async () => {
  const run = timedRun([hitSearch(1, ["a", "b"])]);
  assert.deepEqual(await rerankSides(run, OVERRIDE, ["a", "b"], ["b", "a"]), {
    recorded: null,
    before: "a",
    after: "b",
  });
});

/* - variant ----------------------------------------------------------------------- */

test("variantKey is stable across key order, and differs per change", () => {
  const a: Variant = {
    kind: "definition",
    tool: { name: "x", description: "d", parameters: { a: 1, b: 2 } },
  };
  const b: Variant = {
    kind: "definition",
    tool: { parameters: { b: 2, a: 1 }, description: "d", name: "x" },
  };
  assert.equal(variantKey(a), variantKey(b));
  assert.notEqual(variantKey(a), variantKey({ kind: "remove_tool", tool: "x" }));
});

test("rerankChange: each kind as the catalog change a re-rank applies", () => {
  assert.deepEqual(rerankChange({ kind: "catalog_override", tool: "x", searchable: "s" }).patches, {
    x: "s",
  });
  assert.deepEqual(rerankChange({ kind: "remove_tool", tool: "x" }).hide, ["x"]);
  const craft = rerankChange({
    kind: "tool_craft",
    tools: [{ ...def("m"), replaces: ["a", "b"] }],
  });
  assert.deepEqual(craft.hide, ["a", "b"]);
  assert.deepEqual(
    craft.add.map((tool) => tool.id),
    ["m"],
  );
});

/* - log ------------------------------------------------------------------------- */

test("what_if_variant_built logs the change kind and method, never the definitions", () => {
  const fields = variantBuiltFields(
    { kind: "definition", tool: { name: "hold_fare", description: "SECRET", parameters: {} } },
    "replay",
  );
  assert.deepEqual(fields, { change_kind: "definition", method: "replay" });
});
