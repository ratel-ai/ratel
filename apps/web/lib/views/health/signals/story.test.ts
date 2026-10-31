import assert from "node:assert/strict";
import { test } from "node:test";
import { fresh, signalTurns } from "@/lib/readings/trace-signals/signals/test-fixtures";
import type { SignalKind, TurnStoryStep } from "@/lib/readings/trace-signals/view";
import { type LiveEvent, storyOf } from "@/lib/views/health/signals/story";

function tell(
  kind: SignalKind,
  subjectIds: string[],
  build: ReturnType<typeof fresh>,
  live: "all" | "none" | "no_text" = "all",
) {
  const [turn] = signalTurns([build]);
  const events = new Map<string, LiveEvent>(
    live === "none"
      ? []
      : turn!.steps.map((s) => [
          s.traceEventId,
          { query: live === "no_text" ? null : "find the task", traceId: "trace-1" },
        ]),
  );
  return storyOf({
    kind,
    subjectIds,
    names: new Map([["assign_task", "Assign task"]]),
    turn: turn!,
    steps: turn!.steps,
    events,
  });
}

const flags = (steps: readonly TurnStoryStep[]) => steps.map((s) => s.flag?.label ?? null);

test("a chain story flags the second search it needed", () => {
  const story = tell(
    "sequence_chain",
    ["find_task", "assign_task"],
    fresh().search(["find_task"]).invoke("find_task").search(["assign_task"]).invoke("assign_task"),
  );
  assert.deepEqual(flags(story.steps), [
    null,
    null,
    "A second search to reach the next tool",
    null,
  ]);
  assert.equal(story.traceId, "trace-1");
  const [first, second] = story.steps;
  assert.deepEqual(first, {
    kind: "search",
    query: { state: "captured", text: "find the task" },
    listed: 1,
    eventId: first?.eventId,
  });
  assert.deepEqual(second, {
    kind: "invoke",
    toolId: "find_task",
    pickedRank: 1,
    outcome: "ok",
    tookMs: 120,
    eventId: second?.eventId,
  });
  // Each step names its `trace_events` row, so an example can open it in Traces.
  for (const step of story.steps) assert.match(step.eventId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(new Set(story.steps.map((step) => step.eventId)).size, story.steps.length);
});

test("an error loop flags the failure and each retry", () => {
  const story = tell(
    "error_loop",
    ["link"],
    fresh().search(["link"]).invoke("link").error("link").invoke("link").error("link"),
  );
  assert.deepEqual(flags(story.steps), [null, "Fails", "Retried"]);
});

test("a first-try miss flags the search the agent had to repeat", () => {
  const ask = { query: "hand this to Priya" };
  const story = tell(
    "first_try_miss",
    ["assign_task"],
    fresh().search(["x", "y"], ask).search(["assign_task"], ask).invoke("assign_task"),
  );
  assert.equal(story.steps[0]?.flag?.label, "Assign task not listed");
  const nextStep = tell(
    "first_try_miss",
    ["assign_task"],
    fresh().search(["x", "y"]).invoke("x").search(["assign_task"]).invoke("assign_task"),
  );
  assert.ok(
    nextStep.steps.every((s) => s.flag === undefined),
    "a new ask is not flagged as a miss",
  );
});

test("queries read live: pruned rows are expired, rows without text are not captured", () => {
  const build = () => fresh().search(["a"]).invoke("a");
  assert.deepEqual(
    (tell("padding_share", [], build(), "none").steps[0] as { query: unknown }).query,
    { state: "expired" },
  );
  assert.deepEqual(
    (tell("padding_share", [], build(), "no_text").steps[0] as { query: unknown }).query,
    { state: "not_captured" },
  );
  assert.equal(tell("padding_share", [], build(), "none").traceId, null);
  assert.equal(tell("padding_share", [], build()).steps[0]?.flag?.label, "1 listed, picked #1");
});

/** An OTLP-lane story: lone tool-call rows, with the live rows' captured-result bits. */
function tellOtel(
  kind: SignalKind,
  subjectIds: string[],
  build: ReturnType<typeof fresh>,
  empty: readonly boolean[] = [],
) {
  const [turn] = signalTurns([build]);
  const events = new Map<string, LiveEvent>(
    turn!.steps.map((s, i) => [
      s.traceEventId,
      { query: null, traceId: "trace-otel", resultEmpty: empty[i] ?? null },
    ]),
  );
  return storyOf({ kind, subjectIds, names: new Map(), turn: turn!, steps: turn!.steps, events });
}

const otelTurn = () => fresh({ lane: "otlp", traceId: "trace-otel" });

test("a tool switch flags the call that let the agent down and the tool it switched to", () => {
  const failed = tellOtel("tool_switch", ["a", "b"], otelTurn().end("x").error("a").end("b"));
  assert.deepEqual(flags(failed.steps), [null, "Failed", "Switched to b"]);
  assert.equal(failed.traceId, "trace-otel");
  const empty = tellOtel("tool_switch", ["a", "b"], otelTurn().end("a").end("b"), [true, false]);
  assert.deepEqual(flags(empty.steps), ["Came back empty", "Switched to b"]);
});

test("empty results, unknown tools and long turns flag the calls they are about", () => {
  const empty = tellOtel("empty_result", ["a"], otelTurn().end("a").end("a").end("a"), [
    true,
    false,
    true,
  ]);
  assert.deepEqual(flags(empty.steps), ["Came back empty", null, "Came back empty"]);
  const unknown = tellOtel(
    "unknown_tool",
    ["ghost"],
    otelTurn().error("ghost").end("b").error("ghost"),
  );
  assert.deepEqual(flags(unknown.steps), ["Not a tool the agent has", null, "Called again"]);
  const long = tellOtel("long_turn", ["page"], otelTurn().end("search").end("page").end("page"));
  assert.deepEqual(flags(long.steps), [null, "page shows up often in long turns", null]);
});
