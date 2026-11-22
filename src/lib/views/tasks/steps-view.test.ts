import assert from "node:assert/strict";
import { test } from "node:test";
import { kindsOf, type PublicStepKind, type StepsView } from "@/lib/readings/trace-signals/steps";
import type { TrackSegment } from "@/lib/views/session-chat/model";
import type { StepView, TaskDetailModel } from "@/lib/views/tasks/model";
import {
  segmentAnnotation,
  showsSegment,
  stepsViewHref,
  taskStepsView,
} from "@/lib/views/tasks/steps-view";

const VIEWS: readonly StepsView[] = ["all", "tools", "models", "intents", "flow"];
const KINDS: readonly PublicStepKind[] = [
  "user_message",
  "model_call",
  "tool_call",
  "skill",
  "code",
  "handoff",
];

function step(kind: PublicStepKind, mark: StepView["mark"] = null): StepView {
  const toolId = `${kind}:x`;
  return {
    kind,
    toolId,
    label: kind,
    role: "core",
    position: 1,
    runs: 4,
    runShare: 1,
    calls: 4,
    failures: 0,
    failureShare: 0,
    retries: 0,
    switches: 0,
    gaveUp: 0,
    medianMs: null,
    handoffMs: null,
    next: [],
    mark,
  };
}

function task(): Pick<TaskDetailModel, "steps" | "sideSteps" | "flow"> {
  const steps = KINDS.map((kind) => step(kind, kind === "tool_call" ? "failing" : null));
  return {
    steps,
    sideSteps: [step("skill")],
    flow: {
      edges: [
        { a: "model_call:x", b: "tool_call:x", n: 3, na: 4 },
        { a: "tool_call:x", b: "code:x", n: 2, na: 3 },
      ],
      tools: steps.map((s) => ({ toolId: s.toolId, n: 4 })),
    },
  };
}

test("each task preset keeps the step kinds kindsOf says, in the drawing too", () => {
  for (const view of VIEWS) {
    const shown = taskStepsView(task(), view);
    const kinds = kindsOf(view);
    assert.deepEqual(
      shown.steps.map((s) => s.kind),
      KINDS.filter((kind) => kinds.includes(kind)),
      view,
    );
    assert.equal(shown.sideSteps.length, kinds.includes("skill") ? 1 : 0, view);
    assert.ok(
      shown.flow.tools.every(
        (tool) =>
          shown.steps.some((s) => s.toolId === tool.toolId) ||
          shown.sideSteps.some((s) => s.toolId === tool.toolId),
      ),
      view,
    );
    assert.ok(
      shown.flow.edges.every(
        (edge) =>
          shown.flow.tools.some((t) => t.toolId === edge.a) &&
          shown.flow.tools.some((t) => t.toolId === edge.b),
      ),
      view,
    );
  }
  assert.equal(taskStepsView(task(), "flow").flow.edges.length, 2);
  assert.equal(taskStepsView(task(), "models").flow.edges.length, 0);
});

test("flow drops the step marks; the other presets keep them", () => {
  assert.equal(taskStepsView(task(), "flow").steps.find((s) => s.kind === "tool_call")?.mark, null);
  assert.equal(
    taskStepsView(task(), "tools").steps.find((s) => s.kind === "tool_call")?.mark,
    "failing",
  );
  assert.equal(taskStepsView(task(), "flow").annotations, false);
  assert.equal(taskStepsView(task(), "all").annotations, true);
});

test("each replay preset shows the steps kindsOf says; searches go with tools, asks and waits always show", () => {
  const segment = (
    kind: TrackSegment["kind"],
    publicKind: PublicStepKind | null,
  ): Pick<TrackSegment, "kind" | "publicKind"> => ({ kind, publicKind });
  const steps = KINDS.map((kind) => segment(kind === "skill" ? "tool_call" : kind, kind));
  for (const view of VIEWS) {
    assert.deepEqual(
      steps.filter((s) => showsSegment(s, view)).map((s) => s.publicKind),
      KINDS.filter((kind) => kindsOf(view).includes(kind)),
      view,
    );
    assert.equal(
      showsSegment(segment("search", null), view),
      view === "all" || view === "tools",
      view,
    );
    assert.equal(showsSegment(segment("ask", null), view), true);
    assert.equal(showsSegment(segment("wait", null), view), true);
  }
});

test("annotations: thinking tokens on model calls, the turn's intent and tone on its first user message, none in flow", () => {
  const model = {
    kind: "model_call",
    publicKind: "model_call",
    reasoningTokens: 1_250,
    stepIndex: 3,
    turnIndex: 1,
  } as const;
  const message = {
    kind: "user_message",
    publicKind: "user_message",
    stepIndex: 2,
    turnIndex: 1,
  } as const;
  const chat = {
    segments: [
      { kind: "ask", stepIndex: 1, turnIndex: 1 },
      message,
      model,
      { kind: "user_message", stepIndex: 4, turnIndex: 1 },
    ] as TrackSegment[],
    intents: { 1: { topic: "Flight changes", sentiment: "negative" as const } },
  };
  assert.equal(segmentAnnotation(model, "models", chat), "Thinking · 1,250 tokens");
  assert.equal(segmentAnnotation(message, "intents", chat), "Flight changes · negative");
  assert.equal(
    segmentAnnotation(chat.segments[3]!, "intents", chat),
    null,
    "only the turn's first user message",
  );
  assert.equal(segmentAnnotation(model, "flow", chat), null);
  assert.equal(segmentAnnotation(message, "flow", chat), null);
  assert.equal(segmentAnnotation({ ...model, reasoningTokens: null }, "all", chat), null);
});

test("the preset link keeps the other query values and drops the default", () => {
  assert.equal(stepsViewHref("/p/s", "?t=12&zoom=2", "flow"), "/p/s?t=12&zoom=2&steps=flow");
  assert.equal(
    stepsViewHref("/p/s", "?steps=flow&peek=step%3A3", "models"),
    "/p/s?steps=models&peek=step%3A3",
  );
  assert.equal(stepsViewHref("/p/s", "?steps=flow", "all"), "/p/s");
});
