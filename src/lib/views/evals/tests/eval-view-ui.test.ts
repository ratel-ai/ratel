import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { EvalDefinition } from "@/components/console/evals/EvalDefinition";
import { EvalHeader } from "@/components/console/evals/EvalHeader";
import { EditReply } from "@/components/console/evals/EvalRunReplay";
import { EvalRunsTable } from "@/components/console/evals/EvalRunsTable";
import { SingleTestView } from "@/components/console/evals/SingleTestView";
import type { Eval, EvalResult, EvalRun } from "@/lib/views/evals/domain/types";
import { evalRules } from "@/lib/views/evals/test-view";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";

const AT = new Date("2026-11-08T09:10:00Z");
const ITEM: Eval = {
  id: "e1",
  projectId: PROJECT_ID,
  name: "Flight cancelled, rebook",
  sourceTurnId: "t1",
  sourceCaseId: null,
  message: "My flight was cancelled. Rebook me.",
  earlierMessages: [{ role: "user", text: "Hi" }],
  turns: [],
  checks: { max_tool_calls: { on: true, max: 2 } },
  expectedTool: null,
  criteria: "",
  fixedAnswers: [],
  status: "approved",
  origin: "user",
  tasks: ["wf-1"],
  createdBy: "u",
  createdAt: AT,
  updatedAt: AT,
};
const RUN: EvalRun = {
  id: "run1",
  projectId: PROJECT_ID,
  kind: "nightly",
  fixId: null,
  suite: "All evals",
  status: "completed",
  spend: { usd: 0, reservedUsd: 0, reserved: false },
  evalCount: 20,
  error: null,
  createdBy: "u",
  createdAt: AT,
  startedAt: AT,
  finishedAt: AT,
};
const RULES = evalRules([[{ kind: "ends_well" }, { kind: "max_cost_usd", max: 0.0177 }]], ITEM);
const RESULT: EvalResult = {
  id: "r1",
  projectId: PROJECT_ID,
  runId: "run1",
  evalId: "e1",
  side: "before",
  passed: false,
  change: "now_fails",
  error: null,
  createdAt: AT,
  verdicts: [
    { kind: "ends_well", status: "pass", measured: null, limit: null, detail: "ends well" },
    { kind: "max_cost_usd", status: "fail", measured: 0.0194, limit: 0.0177, detail: "" },
    { kind: "max_tool_calls", status: "fail", measured: 3, limit: 2, detail: "3 calls" },
  ],
  durationMs: 14_000,
  costUsd: 0.0194,
  toolCalls: 3,
  toolAnswers: [
    { tool: "find_booking", source: "recorded", reason: "matched_recording", ms: 480 },
    { tool: "rebook_and_notify", source: "composed", reason: "merged_from_sources", ms: 900 },
    { tool: "send_message", source: "stand-in", reason: "stand_in_model", ms: 490 },
  ],
  transcript: {
    toolsOffered: ["find_booking", "rebook_and_notify", "send_message"],
    steps: [
      { role: "assistant", text: "", calls: [{ name: "find_booking", args: {} }] },
      { role: "tool", tool: "find_booking", content: "{}", isError: false },
      { role: "assistant", text: "", calls: [{ name: "rebook_and_notify", args: {} }] },
      { role: "tool", tool: "rebook_and_notify", content: "{}", isError: false },
      { role: "assistant", text: "", calls: [{ name: "send_message", args: {} }] },
      { role: "tool", tool: "send_message", content: "{}", isError: false },
      { role: "assistant", text: "You are on MR319.", calls: [] },
    ],
  },
};

test("one eval has three tabs, and inside a run it shows 17 of 20 with previous and next", () => {
  const html = render(
    createElement(EvalHeader, {
      projectId: PROJECT_ID,
      evalId: "e1",
      name: ITEM.name,
      passed: false,
      runCount: 8,
      runId: "run1",
      runLabel: "Nightly · 2026-11-08 09:10",
      position: { index: 17, total: 20, prev: "e0", next: "e2" },
    }),
  );
  const text = visibleText(html);
  for (const word of [
    "This run",
    "Runs",
    "Definition",
    "17 of 20",
    "Fails",
    "Nightly · 2026-11-08 09:10",
  ])
    assert.ok(text.includes(word), word);
  assert.ok(html.includes(`/evals/e0?run=run1`) && html.includes(`/evals/e2?run=run1`));
  assert.ok(
    html.includes(`href="/project/${PROJECT_ID}/evals/runs/run1"`),
    "The breadcrumb goes back to the run table.",
  );
  const last = visibleText(
    render(
      createElement(EvalHeader, {
        projectId: PROJECT_ID,
        evalId: "e1",
        name: ITEM.name,
        runCount: 8,
      }),
    ),
  );
  assert.ok(last.includes("Last run") && !last.includes(" of "));
});

test("the test view (RC-657): scorers first, then the scenario, then the replay; source badges and counts in the term list, a simulated answer in amber", () => {
  const html = render(
    createElement(SingleTestView, {
      item: ITEM,
      tasks: [{ id: "wf-1", label: "Rebook a disrupted flight" }],
      rules: RULES,
      run: RUN,
      result: RESULT,
      replayHref: "/r",
    }),
  );
  const text = visibleText(html);
  for (const word of [
    "Scenario",
    "My flight was cancelled. Rebook me.",
    "After 1 earlier message",
    "Rebook a disrupted flight",
    "Scorers",
    "The last tool call succeeds and the agent replies",
    "Costs at most $0.0177",
    "$0.0194",
    "At most 2 tool calls",
    "Replay",
    "Open the full replay",
    "Tool answers:",
    "1 merged",
    "1 recorded",
    "1 simulated answer",
    "Tools offered 3 tools",
    "find_booking",
    "14 s · $0.0194 · 3 tool calls",
    "Eval run text expires after 30 days",
  ]) {
    assert.ok(text.includes(word), word);
  }
  assert.ok(
    html.includes("data-eval-run-replay") && html.includes("data-session-track"),
    "RC-648: a run with its text plays in the session replay of Traces.",
  );
  assert.ok(
    html.includes('data-chat-panel="step"') && html.includes('data-eval-step-actions="assistant"'),
    "The inspector opens on the first model call, with the eval's actions.",
  );
  assert.ok(!html.includes("data-open-full-trace"), "An eval run has no trace to open.");
  const step = (n: number) =>
    render(
      createElement(SingleTestView, {
        item: ITEM,
        tasks: [],
        rules: RULES,
        run: RUN,
        result: RESULT,
        replayHref: "/r",
      }),
      { search: `?peek=step:${n}` },
    );
  assert.ok(
    text.indexOf("Scorers") < text.indexOf("Scenario") &&
      text.indexOf("Scenario") < text.indexOf("Replay"),
    "RC-657: the result first.",
  );
  assert.ok(/bg-warning-subtle[^>]*>Simulated answer</.test(step(7)), "Its badge is amber.");
  assert.ok(/bg-info-subtle[^>]*>Merged</.test(step(5)));
  assert.ok(!text.includes("No text for this run"));
});

test('a result without a transcript renders with the expired-text note (RC-642: not "Text is off") and keeps the sources', () => {
  const text = visibleText(
    render(
      createElement(SingleTestView, {
        item: ITEM,
        tasks: [],
        rules: RULES,
        run: RUN,
        result: { ...RESULT, transcript: null },
        replayHref: null,
      }),
    ),
  );
  assert.ok(text.includes("No text for this run") && text.includes("30 days"));
  assert.ok(!text.includes("Text is off"));
  assert.ok(text.includes("1 simulated answer") && text.includes("send_message"));
  assert.ok(!text.includes("You are on MR319.") && !text.includes("Tools offered"));
  assert.match(
    visibleText(
      render(
        createElement(SingleTestView, {
          item: ITEM,
          tasks: [],
          rules: RULES,
          run: null,
          result: null,
          replayHref: null,
        }),
      ),
    ),
    /Not run yet/,
  );
});

test("runs tab lists each run with marks and the definition tab shows no results", () => {
  const runs = visibleText(
    render(
      createElement(EvalRunsTable, {
        projectId: PROJECT_ID,
        evalId: "e1",
        rows: [
          { run: RUN, result: RESULT },
          {
            run: { ...RUN, id: "s", kind: "simulation", fixId: "craft:1" },
            result: { ...RESULT, id: "r2", passed: true },
          },
        ],
      }),
    ),
  );
  for (const word of ["Nightly", "Simulation", "craft:1", "Fails", "Passes", "14 s · $0.0194"])
    assert.ok(runs.includes(word), word);
  const definition = visibleText(
    render(
      createElement(EvalDefinition, {
        item: ITEM,
        tasks: [{ id: "wf-1", label: "Rebook a disrupted flight" }],
        rules: RULES,
      }),
    ),
  );
  for (const word of [
    "Scenario",
    "Environment",
    "Expectations",
    "Earlier messages",
    "Tested message",
    "When it passes",
    "Its task",
    "This eval",
    "Fixed answers",
    "How tool answers are chosen",
    "Check it before you trust the result",
  ])
    assert.ok(definition.includes(word), word);
  assert.ok(
    definition.indexOf("Scenario") < definition.indexOf("Environment") &&
      definition.indexOf("Environment") < definition.indexOf("Expectations"),
    "RC-657: the audited order.",
  );
  assert.ok(
    !definition.includes("Fails") && !definition.includes("Passes"),
    "No results on Definition.",
  );
});

test("RC-309: a simulated-person result shows its pass rate and each turn with its kind, result and verdicts", () => {
  const multi: EvalResult = {
    ...RESULT,
    passed: false,
    attempts: { passed: 2, total: 3 },
    turns: [
      {
        simulated: false,
        message: "My flight was cancelled. Rebook me.",
        passed: true,
        verdicts: [{ kind: "max_tool_calls", status: "pass", measured: 2, limit: 3, detail: "" }],
        answers: 2,
      },
      {
        simulated: true,
        message: "And tomorrow morning instead?",
        passed: false,
        verdicts: [{ kind: "max_tool_calls", status: "fail", measured: 4, limit: 3, detail: "" }],
        answers: 1,
      },
    ],
  };
  const html = render(
    createElement(SingleTestView, {
      item: { ...ITEM, turns: [{ kind: "person", description: "A traveler" }] },
      tasks: [],
      rules: RULES,
      run: RUN,
      result: multi,
      replayHref: null,
    }),
  );
  const text = visibleText(html);
  assert.match(text, /Passed 2 of 3 runs/);
  assert.match(
    text,
    /Turn 1 Fixed message Passes My flight was cancelled\. Rebook me\. Tool calls 2/,
  );
  assert.match(text, /Turn 2 Simulated person Fails And tomorrow morning instead\? Tool calls 4/);
  assert.deepEqual(
    [...html.matchAll(/data-turn-status="(\w+)"/g)].map((m) => m[1]),
    ["pass", "fail"],
  );
});

test("RC-309: a single-turn result renders as before: no pass rate, no turn list", () => {
  const html = render(
    createElement(SingleTestView, {
      item: ITEM,
      tasks: [],
      rules: RULES,
      run: RUN,
      result: RESULT,
      replayHref: null,
    }),
  );
  assert.ok(!html.includes("data-attempts"));
  assert.ok(!html.includes("data-turns"));
  const older = render(
    createElement(SingleTestView, {
      item: ITEM,
      tasks: [],
      rules: RULES,
      run: RUN,
      result: { ...RESULT, turns: null, attempts: null },
      replayHref: null,
    }),
  );
  assert.equal(older, html);
});

test("RC-648: the first model call edits the spec with Generated marks; a previous run marks where this one differs on the track", () => {
  const item: Eval = { ...ITEM, systemPrompt: "You rebook flights.", generated: ["systemPrompt"] };
  const result: EvalResult = { ...RESULT, generated: ["systemPrompt"] };
  const steps = RESULT.transcript!.steps.map((s, i) =>
    i === 3 && s.role === "tool" ? { ...s, content: '{"error":"full"}' } : s,
  );
  const previous: EvalResult = {
    ...RESULT,
    id: "r0",
    transcript: { ...RESULT.transcript!, steps },
  };
  const html = render(
    createElement(SingleTestView, {
      item,
      tasks: [],
      rules: RULES,
      run: RUN,
      result,
      replayHref: null,
      previous,
    }),
  );
  assert.match(html, /aria-label="System prompt"/);
  assert.match(html, /aria-label="Message"/);
  assert.match(
    html,
    /System prompt<span[^>]*data-generated-mark[^>]*><span[^>]*bg-info-subtle[^>]*>[\s\S]*?Generated</,
    "RC-657: the one Generated mark, info tone.",
  );
  assert.ok(html.includes("data-simulate-again") && html.includes("data-continue"));
  assert.match(
    html,
    /data-track-marker="5"/,
    "The marker sits on rebook_and_notify, the first step that differs.",
  );
  assert.ok(visibleText(html).includes("Runs differ from here"));
  assert.ok(
    !render(
      createElement(SingleTestView, {
        item,
        tasks: [],
        rules: RULES,
        run: RUN,
        result,
        replayHref: null,
      }),
    ).includes("data-track-marker"),
  );
});

test("RC-654: the inspector of an agent step shows Edit reply; open, it has the reply, its calls and a this-eval / copy choice", () => {
  const html = render(
    createElement(SingleTestView, {
      item: ITEM,
      tasks: [],
      rules: RULES,
      run: RUN,
      result: RESULT,
      replayHref: null,
    }),
  );
  assert.ok(html.includes("data-edit-reply"), "The first step is the agent's first reply.");
  const multi = render(
    createElement(SingleTestView, {
      item: ITEM,
      tasks: [],
      rules: RULES,
      run: RUN,
      result: {
        ...RESULT,
        turns: [{ simulated: false, message: "x", passed: true, verdicts: [], answers: 1 }],
      },
      replayHref: null,
    }),
  );
  assert.ok(!multi.includes("data-edit-reply"), "Not on an eval with turns.");
  const open = render(
    createElement(EditReply, {
      initial: { text: "Let me look.", calls: [{ name: "find_booking", args: { ref: "R1" } }] },
      pending: false,
      defaultOpen: true,
      onRun: () => undefined,
      onError: () => undefined,
    }),
  );
  assert.match(open, /aria-label="Reply text"[^>]*>Let me look\.</);
  assert.match(open, /aria-label="Tool calls"/);
  assert.match(visibleText(open), /Run on This eval A copy/);
  assert.ok(open.includes("data-run-from-reply"));
});

test("RC-653: the replay header lists the run settings a result used, and marks those the eval or the suite chose", () => {
  const sources = {
    agentModel: "eval",
    temperature: "eval",
    maxTokens: "default",
    maxSteps: "suite",
    budgetUsd: "default",
    toolModel: "default",
    judgeModel: "default",
  } as const;
  const runSettings = {
    agentModel: "claude-sonnet-4-6",
    temperature: 0.4,
    maxTokens: 4096,
    maxSteps: 3,
    budgetUsd: 1,
    toolModel: "claude-haiku-5-5",
    judgeModel: "claude-haiku-5-5",
    sources,
  };
  const html = render(
    createElement(SingleTestView, {
      item: ITEM,
      tasks: [],
      rules: RULES,
      run: RUN,
      result: { ...RESULT, runSettings },
      replayHref: null,
    }),
  );
  const text = visibleText(html);
  assert.match(
    text,
    /Agent model claude-sonnet-4-6 · This eval Temperature 0\.4 · This eval Max tokens 4,096 · Default Step limit 3 · Suite default Cost budget \$1 · Default Tool answer model claude-haiku-5-5 · Default Judge model claude-haiku-5-5 · Default/,
  );
  assert.ok(
    !render(
      createElement(SingleTestView, {
        item: ITEM,
        tasks: [],
        rules: RULES,
        run: RUN,
        result: RESULT,
        replayHref: null,
      }),
    ).includes("data-run-settings-used"),
    "A result before RC-653 shows none.",
  );
});
