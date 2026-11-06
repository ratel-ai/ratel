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
  assert.equal(sample.before.choice, "find_booking");
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
