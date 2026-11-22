import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { FixSimulations } from "@/components/console/evals/FixSimulations";
import { RunTableView } from "@/components/console/evals/RunTableView";
import { CompareTestView } from "@/components/console/evals/SingleTestView";
import type { SimulationRow } from "@/lib/views/evals/domain/simulation";
import type { Eval, EvalResult, EvalRun, EvalToolAnswer } from "@/lib/views/evals/domain/types";
import type { FixPageModel } from "@/lib/views/evals/fix-page";
import { fixSimulationHref, fixTestHref } from "@/lib/views/evals/paths";
import { evalRules } from "@/lib/views/evals/test-view";
import { type RunEvalsMenu, runEvalsOptions, simulationTable } from "@/lib/views/evals/view";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";

const AT = new Date("2026-11-08T09:10:00Z");
const FIX = "craft:combine-4";
const run = (over: Partial<EvalRun> = {}): EvalRun => ({
  id: "33333333-3333-4333-8333-333333333333",
  projectId: PROJECT_ID,
  kind: "simulation",
  fixId: FIX,
  suite: "Related tasks",
  status: "completed",
  spend: { usd: 0, reservedUsd: 0, reserved: false },
  evalCount: 6,
  error: null,
  createdBy: "u",
  createdAt: AT,
  startedAt: AT,
  finishedAt: AT,
  ...over,
});
const MENU: RunEvalsMenu = {
  related: 6,
  all: 22,
  failing: 0,
  tasks: [
    { id: "wf-1", label: "Rebook a disrupted flight", count: 6 },
    { id: "wf-2", label: "Look up a flight booking", count: 4 },
  ],
};
const LINES: FixPageModel["lines"] = [
  {
    run: run({ id: "q", suite: "Failing today", status: "queued", evalCount: 8 }),
    suite: "Failing today",
    tasks: [],
    taskTags: [],
    tally: { total: 0, passed: 0, today: 0, fixed: 0, broke: 0, unverified: 0 },
  },
  {
    run: run({ id: "a", suite: "All evals" }),
    suite: "All evals",
    tasks: ["wf-1", "wf-2"],
    taskTags: [
      { id: "wf-1", label: "Rebook a disrupted flight" },
      { id: "wf-2", label: "Look up a flight booking" },
    ],
    tally: { total: 22, passed: 17, today: 14, fixed: 4, broke: 1, unverified: 1 },
  },
  {
    run: run({ id: "r" }),
    suite: "Related tasks",
    tasks: ["wf-1"],
    taskTags: [{ id: "wf-1", label: "Rebook a disrupted flight" }],
    tally: { total: 6, passed: 6, today: 2, fixed: 4, broke: 0, unverified: 0 },
  },
];

const answer = (tool: string, source: EvalToolAnswer["source"] = "recorded"): EvalToolAnswer => ({
  tool,
  source,
  reason: source === "composed" ? "merged_from_sources" : "matched_recording",
  ms: 450,
});
const result = (
  side: "before" | "after",
  passed: boolean,
  tools: string[],
  over: Partial<EvalResult> = {},
): EvalResult => ({
  id: `res-${side}`,
  projectId: PROJECT_ID,
  runId: "r",
  evalId: "e1",
  side,
  passed,
  verdicts: [
    {
      kind: "ends_well",
      status: passed ? "pass" : "fail",
      measured: null,
      limit: null,
      detail: "",
    },
  ],
  change: null,
  durationMs: 3200,
  costUsd: 0.0041,
  toolCalls: tools.length,
  toolAnswers: tools.map((tool) => answer(tool, side === "after" ? "composed" : "recorded")),
  transcript: {
    toolsOffered: side === "after" ? ["rebook_and_notify"] : ["find_booking"],
    steps: [
      ...tools.flatMap((tool) => [
        {
          role: "assistant" as const,
          text: "",
          calls: [{ id: tool, name: tool, args: { ref: "MRD9Q2" } }],
        },
        { role: "tool" as const, tool, content: "{}", isError: false },
      ]),
      {
        role: "assistant" as const,
        text: side === "after" ? "Sorry, something went wrong." : "What is the last name?",
        calls: [],
      },
    ],
  },
  error: null,
  createdAt: AT,
  ...over,
});
const ITEM: Eval = {
  id: "e1",
  projectId: PROJECT_ID,
  name: "Booking reference not found",
  sourceTurnId: null,
  sourceCaseId: null,
  message: "I can't find my booking MRD9Q2.",
  earlierMessages: [],
  turns: [],
  checks: {},
  expectedTool: null,
  criteria: "",
  fixedAnswers: [],
  status: "approved",
  origin: "user",
  tasks: ["wf-2"],
  createdBy: "t",
  createdAt: AT,
  updatedAt: AT,
};
const RULES = evalRules([[{ kind: "ends_well" }]], ITEM);

test("the fix page lists one line per simulation: queued lines say so, done lines show pass count, today and fixed/broke/unverified", () => {
  const html = render(
    createElement(FixSimulations, { projectId: PROJECT_ID, fixId: FIX, lines: LINES, menu: MENU }),
  );
  const text = visibleText(html);
  for (const word of [
    "Simulations",
    "Run evals",
    "Failing today",
    "Queued",
    "8 evals",
    "All evals",
    "2 tasks",
    "17/22",
    "pass · today 14",
    "4 fixed",
    "1 broke",
    "1 unverified",
    "Related tasks",
    "Rebook a disrupted flight",
    "6/6",
    "pass · today 2",
    "8 Nov",
  ]) {
    assert.ok(text.includes(word), word);
  }
  assert.ok(html.includes(`data-status="queued"`) && html.includes(`data-status="completed"`));
  assert.ok(
    html.includes(`href="${fixSimulationHref(PROJECT_ID, FIX, "a")}"`),
    "Each line opens its simulation table.",
  );
  assert.match(
    visibleText(
      render(
        createElement(FixSimulations, { projectId: PROJECT_ID, fixId: FIX, lines: [], menu: MENU }),
      ),
    ),
    /No simulations yet/,
  );
});

test("the Run evals menu offers related tasks, all evals, failing today and each task, with counts", () => {
  const { suites, tasks } = runEvalsOptions(MENU);
  assert.deepEqual(
    suites.map((o) => [o.label, o.count, o.suite.kind]),
    [
      ["Related tasks", 6, "related"],
      ["All evals", 22, "all"],
      ["Failing today", 0, "failing"],
    ],
  );
  assert.deepEqual(
    tasks.map((o) => [o.label, o.count, o.suite]),
    [
      ["Rebook a disrupted flight", 6, { kind: "task", workflowId: "wf-1" }],
      ["Look up a flight booking", 4, { kind: "task", workflowId: "wf-2" }],
    ],
  );
});

test("the simulation table marks Fixed, Broke and Unverified against today, and opens the two-replay view", () => {
  const before = (id: string, passed: boolean) => ({
    ...result("before", passed, ["find_booking"]),
    id: `${id}-b`,
    evalId: id,
  });
  const after = (id: string, passed: boolean, standIn = false) => ({
    ...result("after", passed, ["rebook_and_notify"]),
    id: `${id}-a`,
    evalId: id,
    toolAnswers: standIn ? [answer("rebook_and_notify", "stand-in")] : [],
  });
  const rows: SimulationRow[] = [
    { evalId: "e1", before: before("e1", true), after: after("e1", false), outcome: "broke" },
    { evalId: "e2", before: before("e2", false), after: after("e2", true), outcome: "fixed" },
    {
      evalId: "e3",
      before: before("e3", false),
      after: after("e3", true, true),
      outcome: "unverified",
    },
    { evalId: "e4", before: before("e4", true), after: null, outcome: "same" },
  ];
  const evals = ["e1", "e2", "e3", "e4"].map((id, index) => ({
    ...ITEM,
    id,
    name: ["Booking not found", "Flight cancelled", "Split booking", "Refund"][index]!,
  }));
  const table = simulationTable(rows, evals, new Map(), "all");
  const html = render(
    createElement(RunTableView, {
      projectId: PROJECT_ID,
      runId: "r",
      table,
      filter: "all",
      rowBase: fixSimulationHref(PROJECT_ID, FIX, "r"),
    }),
  );
  const text = visibleText(html);
  for (const word of ["Fixed", "Broke", "Unverified", "Changed 3"])
    assert.ok(text.includes(word), word);
  assert.ok(
    /class="text-danger"[^>]*>Broke</.test(html) &&
      /class="text-success"[^>]*>Fixed</.test(html) &&
      /class="text-warning"[^>]*>Unverified</.test(html),
  );
  assert.ok(
    html.includes("got a simulated answer. Not counted as fixed."),
    "Unverified says why it is not a fix.",
  );
  assert.equal(
    fixTestHref(PROJECT_ID, FIX, "r", "e1"),
    `${fixSimulationHref(PROJECT_ID, FIX, "r")}/e1`,
  );
});

test("a changed test shows Without the fix and With the fix replays with a Runs differ from here line", () => {
  const html = render(
    createElement(CompareTestView, {
      item: ITEM,
      tasks: [],
      rules: RULES,
      before: result("before", true, ["find_booking"]),
      after: result("after", false, ["rebook_and_notify"]),
      replayHref: null,
    }),
  );
  const text = visibleText(html);
  for (const word of [
    "Without the fix",
    "Replayed from the recording",
    "With the fix",
    "Simulated",
    "Today",
    "Runs differ from here",
    "find_booking",
    "rebook_and_notify",
    "Passes",
    "Fails",
  ]) {
    assert.ok(text.includes(word), word);
  }
  assert.equal(
    (html.match(/data-differ/g) ?? []).length,
    2,
    "The line is on both replays, at the same step.",
  );
  assert.ok(!text.includes("Same as today"));
});

test("an unchanged test shows one replay labeled Same as today", () => {
  const html = render(
    createElement(CompareTestView, {
      item: ITEM,
      tasks: [],
      rules: RULES,
      before: result("before", true, ["find_booking"]),
      after: null,
      replayHref: null,
    }),
  );
  const text = visibleText(html);
  assert.ok(text.includes("Same as today"));
  assert.ok(
    !text.includes("Without the fix") &&
      !text.includes("With the fix") &&
      !text.includes("Runs differ from here"),
  );
  assert.equal((html.match(/Tools offered/g) ?? []).length, 1, "One replay.");
});

// Owned (ADR-0030): upstream's case "the old per-task Simulations pages are gone and nothing
// links to them" is left out: the core keeps the eval gate's task Simulations pages (with
// FF_EVAL_GATE), beside the Evals fix page.
