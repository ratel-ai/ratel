import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { DefinitionsTable } from "@/components/console/evals/DefinitionsTable";
import { RunHeadline } from "@/components/console/evals/RunHeadline";
import { RunsList } from "@/components/console/evals/RunsList";
import { RunTableView } from "@/components/console/evals/RunTableView";
import { StatusFilter } from "@/components/console/evals/StatusFilter";
import { TaskFilter } from "@/components/console/evals/TaskFilter";
import type { Eval, EvalResult, EvalRun } from "@/lib/views/evals/domain/types";
import { evalRunHref, evalsHref, parseEvalStatusFilter } from "@/lib/views/evals/paths";
import {
  type DefinitionRow,
  definitionRows,
  type RunTable,
  runTable,
} from "@/lib/views/evals/view";
import { PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";

const AT = new Date("2026-11-08T09:10:00Z");
const run = (over: Partial<EvalRun> = {}): EvalRun => ({
  id: "33333333-3333-4333-8333-333333333333",
  projectId: PROJECT_ID,
  kind: "manual",
  fixId: null,
  suite: "All evals",
  status: "completed",
  spend: { usd: 0, reservedUsd: 0, reserved: false },
  evalCount: 3,
  error: null,
  createdBy: "u",
  createdAt: AT,
  startedAt: AT,
  finishedAt: AT,
  ...over,
});
const DEFINITIONS: DefinitionRow[] = [
  {
    id: "e1",
    name: "Flight cancelled, rebook",
    suggested: false,
    tasks: [
      { id: "wf-1", label: "Rebook a disrupted flight" },
      { id: "wf-2", label: "Rebook to a new date" },
    ],
    checks: 4,
    last6: ["none", "none", "pass", "pass", "error", "fail"],
    last: "fail",
  },
  {
    id: "e2",
    name: "Where is my refund?",
    suggested: true,
    tasks: [{ id: "wf-3", label: "Refund status" }],
    checks: 1,
    last6: ["none", "none", "none", "none", "none", "none"],
    last: null,
  },
];

test("definitions table: eval, task tags, check count, last 6 runs and last result in words", () => {
  const text = visibleText(
    render(
      createElement(DefinitionsTable, {
        projectId: PROJECT_ID,
        rows: DEFINITIONS,
        filtered: false,
      }),
    ),
  );
  for (const word of [
    "Eval",
    "Tasks",
    "Scorers",
    "Last 6 runs",
    "Last run",
    "Flight cancelled, rebook",
    "Rebook a disrupted flight",
    "Rebook to a new date",
    "4 built-in",
    "1 built-in",
    "Fails",
    "Not run yet",
  ]) {
    assert.ok(text.includes(word), word);
  }
  const html = render(
    createElement(DefinitionsTable, { projectId: PROJECT_ID, rows: DEFINITIONS, filtered: false }),
  );
  assert.equal(
    text.match(/Suggested/g)?.length,
    1,
    "Only the suggestion has the label; there is no Approve or Dismiss.",
  );
  assert.doesNotMatch(text, /Approve|Dismiss/);
  assert.match(
    html,
    /Last 6 runs, oldest first: no run, no run, passed, passed, could not run, failed/,
  );
  assert.match(
    visibleText(
      render(createElement(DefinitionsTable, { projectId: PROJECT_ID, rows: [], filtered: true })),
    ),
    /No evals match these filters/,
  );
  assert.match(
    visibleText(
      render(createElement(DefinitionsTable, { projectId: PROJECT_ID, rows: [], filtered: false })),
    ),
    /No evals yet/,
  );
});

test("task filter shows the picked task and links keep it in the URL", () => {
  const tasks = [{ id: "wf-1", label: "Rebook a disrupted flight" }];
  assert.match(visibleText(render(createElement(TaskFilter, { tasks, value: null }))), /All tasks/);
  assert.match(
    visibleText(render(createElement(TaskFilter, { tasks, value: "wf-1" }))),
    /Rebook a disrupted flight/,
  );
  assert.equal(evalsHref(PROJECT_ID, { task: "wf-1" }), `/project/${PROJECT_ID}/evals?task=wf-1`);
  assert.equal(evalsHref(PROJECT_ID, { tab: "runs" }), `/project/${PROJECT_ID}/evals/runs`);
});

test("runs list: kind, what it ran, pass count, change text, and queued, running and failed states", () => {
  const rows = [
    {
      run: run({ kind: "nightly" }),
      suite: "All evals",
      summary: { passed: 14, total: 22, nowFails: 1, fixed: 0 },
    },
    {
      run: run({ id: "a", kind: "simulation", fixId: "craft:1", suite: "Related tasks" }),
      suite: "Related tasks",
      summary: { passed: 6, total: 6, nowFails: 0, fixed: 4 },
    },
    {
      run: run({ id: "b", status: "queued", suite: "Task wf-1" }),
      suite: "Task: Refund status",
      summary: { passed: 0, total: 0, nowFails: 0, fixed: 0 },
    },
    {
      run: run({ id: "c", status: "running" }),
      suite: "All evals",
      summary: { passed: 0, total: 0, nowFails: 0, fixed: 0 },
    },
    {
      run: run({ id: "d", status: "failed", error: "The project is gone." }),
      suite: "All evals",
      summary: { passed: 0, total: 0, nowFails: 0, fixed: 0 },
    },
  ];
  const text = visibleText(render(createElement(RunsList, { projectId: PROJECT_ID, rows })));
  for (const word of [
    "Nightly",
    "Simulation",
    "Manual",
    "Agent as recorded · All evals",
    "Fix craft:1 · Related tasks",
    "Agent as recorded · Task: Refund status",
    "14/22",
    "pass",
    "1 now fails",
    "4 fixed",
    "Queued",
    "Running",
    "Failed",
    "The project is gone.",
  ]) {
    assert.ok(text.includes(word), word);
  }
  assert.doesNotMatch(text, /wf-1/);
  assert.match(
    visibleText(render(createElement(RunsList, { projectId: PROJECT_ID, rows: [] }))),
    /No runs yet/,
  );
});

test("run table: a check or cross per scorer, a dot when it does not apply, changed results outlined, filter counts", () => {
  const table: RunTable = {
    columns: ["ends_well", "max_tool_calls"],
    rows: [
      {
        evalId: "e1",
        name: "Flight cancelled, rebook",
        tasks: [],
        cells: { ends_well: "pass", max_tool_calls: "fail" },
        passed: false,
        change: "now_fails",
        outlined: true,
        error: null,
        attempts: null,
      },
      {
        evalId: "e2",
        name: "Where is my refund?",
        tasks: [],
        cells: { ends_well: "dot", max_tool_calls: "pass" },
        passed: true,
        change: "same",
        outlined: false,
        error: null,
        attempts: null,
      },
      {
        evalId: "e3",
        name: "Gone",
        tasks: [],
        cells: { ends_well: "dot", max_tool_calls: "dot" },
        passed: null,
        change: null,
        outlined: false,
        error: "The recorded run is gone.",
        attempts: null,
      },
    ],
    counts: { all: 3, failing: 2, changed: 1 },
  };
  const html = render(
    createElement(RunTableView, { projectId: PROJECT_ID, runId: "r", table, filter: "all" }),
  );
  const text = visibleText(html);
  for (const word of [
    "Finishes cleanly",
    "Tool calls",
    "Change",
    "Now fails",
    "Could not run",
    "All 3",
    "Failing 2",
    "Changed 1",
  ])
    assert.ok(text.includes(word), word);
  assert.equal(html.match(/data-mark="pass"/g)?.length, 2);
  assert.equal(html.match(/data-mark="fail"/g)?.length, 1);
  assert.equal(html.match(/aria-label="Does not apply"/g)?.length, 3);
  assert.equal(
    html.match(/data-outlined=""/g)?.length,
    2,
    "Both marks of the changed row are outlined; no dot is.",
  );
  assert.equal(
    evalRunHref(PROJECT_ID, "r", "failing"),
    `/project/${PROJECT_ID}/evals/runs/r?show=failing`,
  );
  assert.match(
    visibleText(
      render(
        createElement(RunTableView, {
          projectId: PROJECT_ID,
          runId: "r",
          table: { ...table, rows: [] },
          filter: "changed",
        }),
      ),
    ),
    /Nothing changed/,
  );
});

test("a run's headline: pass count and change, or its queued, running or failed state", () => {
  const summary = { passed: 14, total: 22, nowFails: 1, fixed: 0 };
  assert.match(
    visibleText(
      render(
        createElement(RunHeadline, {
          run: run(),
          summary,
          previous: run({ createdAt: new Date("2026-11-07T09:10:00Z") }),
        }),
      ),
    ),
    /14 of 22 pass · compared with 7 Nov, 09:10 · 1 now fails/,
  );
  assert.match(
    visibleText(render(createElement(RunHeadline, { run: run(), summary, previous: null }))),
    /the first run/,
  );
  assert.match(
    visibleText(
      render(
        createElement(RunHeadline, { run: run({ status: "queued" }), summary, previous: null }),
      ),
    ),
    /Queued/,
  );
  assert.match(
    visibleText(
      render(
        createElement(RunHeadline, { run: run({ status: "running" }), summary, previous: null }),
      ),
    ),
    /Running/,
  );
  assert.match(
    visibleText(
      render(
        createElement(RunHeadline, {
          run: run({ status: "failed", error: "boom" }),
          summary,
          previous: null,
        }),
      ),
    ),
    /The run failed boom/,
  );
});

test('RC-309: a run table row shows "2 of 3" next to the eval that ran 3 times', () => {
  const row = (evalId: string, attempts: string | null) => ({
    evalId,
    name: `Eval ${evalId}`,
    tasks: [],
    cells: {},
    passed: false,
    change: null,
    outlined: false,
    error: null,
    attempts,
  });
  const html = render(
    createElement(RunTableView, {
      projectId: PROJECT_ID,
      runId: "r",
      filter: "all",
      table: {
        columns: [],
        rows: [row("a", "2 of 3"), row("b", null)],
        counts: { all: 2, failing: 2, changed: 0 },
      },
    }),
  );
  assert.match(visibleText(html), /Eval a 2 of 3/);
  assert.equal(html.match(/data-attempts/g)?.length, 1, "Only the eval that ran several times.");
});

test("RC-316: the definitions table and the run table show each task by name, an unlabelled one as Untitled task, never its id", () => {
  const anEval = (id: string, tasks: string[]): Eval => ({
    id,
    projectId: PROJECT_ID,
    name: `Eval ${id}`,
    sourceTurnId: null,
    sourceCaseId: null,
    message: "m",
    earlierMessages: [],
    turns: [],
    checks: {},
    expectedTool: null,
    criteria: "",
    fixedAnswers: [],
    status: "approved",
    origin: "user",
    tasks,
    createdBy: "t",
    createdAt: AT,
    updatedAt: AT,
  });
  const result = (evalId: string): EvalResult => ({
    id: `r-${evalId}`,
    projectId: PROJECT_ID,
    runId: "run",
    evalId,
    side: "before",
    passed: true,
    verdicts: [],
    change: null,
    durationMs: null,
    costUsd: null,
    toolCalls: null,
    toolAnswers: [],
    transcript: null,
    error: null,
    createdAt: AT,
  });
  const evals = [anEval("a", ["wf-7f3a9c01"]), anEval("b", ["wf-0b1e22d4"])];
  const names = new Map([["wf-7f3a9c01", "Refund status"]]);
  const definitions = visibleText(
    render(
      createElement(DefinitionsTable, {
        projectId: PROJECT_ID,
        rows: definitionRows(evals, new Map(), new Map(), names),
        filtered: false,
      }),
    ),
  );
  const runs = visibleText(
    render(
      createElement(RunTableView, {
        projectId: PROJECT_ID,
        runId: "r",
        filter: "all",
        table: runTable([result("a"), result("b")], evals, names, "all"),
      }),
    ),
  );
  for (const text of [definitions, runs]) {
    assert.ok(text.includes("Refund status"));
    assert.ok(text.includes("Untitled task"));
    assert.doesNotMatch(text, /wf-7f3a9c01|wf-0b1e22d4/);
  }
});

test("RC-323: ?status=suggested shows only suggested rows, All shows all; the filter keeps the task in the URL", () => {
  const anEval = (id: string, status: Eval["status"]): Eval => ({
    id,
    projectId: PROJECT_ID,
    name: `Eval ${id}`,
    sourceTurnId: null,
    sourceCaseId: null,
    message: "m",
    earlierMessages: [],
    turns: [],
    checks: {},
    expectedTool: null,
    criteria: "",
    fixedAnswers: [],
    status,
    origin: "auto",
    tasks: ["wf-1"],
    createdBy: "t",
    createdAt: AT,
    updatedAt: AT,
  });
  const evals = [anEval("mine", "approved"), anEval("s1", "suggested"), anEval("s2", "suggested")];
  const names = new Map([["wf-1", "Refund status"]]);
  const table = (status: "suggested" | null) =>
    visibleText(
      render(
        createElement(DefinitionsTable, {
          projectId: PROJECT_ID,
          rows: definitionRows(evals, new Map(), new Map(), names, undefined, status),
          filtered: status !== null,
        }),
      ),
    );
  assert.equal(parseEvalStatusFilter("suggested"), "suggested");
  assert.equal(parseEvalStatusFilter(undefined), null);
  assert.equal(parseEvalStatusFilter("nope"), null);
  const suggested = table(parseEvalStatusFilter("suggested"));
  assert.ok(suggested.includes("Eval s1") && suggested.includes("Eval s2"));
  assert.doesNotMatch(suggested, /Eval mine/);
  const all = table(parseEvalStatusFilter(undefined));
  for (const name of ["Eval mine", "Eval s1", "Eval s2"]) assert.ok(all.includes(name), name);
  const filter = visibleText(
    render(
      createElement(StatusFilter, { value: "suggested", task: "wf-1", total: 3, suggested: 2 }),
    ),
  );
  assert.ok(filter.includes("All") && filter.includes("Suggested"));
  assert.equal(
    evalsHref(PROJECT_ID, { task: "wf-1", status: "suggested" }),
    `/project/${PROJECT_ID}/evals?task=wf-1&status=suggested`,
  );
});

test("RC-658: scorer kinds use the term list; the scorer list shows On as a word, not a success badge", async () => {
  const { KIND_LABELS } = await import("@/lib/views/scorers/view");
  assert.deepEqual(KIND_LABELS, {
    check: "Field check",
    expression: "JSON rule",
    judge: "Model judge",
    decision: "Model question",
  });
  const { ScorerList } = await import("@/components/console/scorers/ScorerList");
  const html = render(
    createElement(ScorerList, {
      projectId: PROJECT_ID,
      scope: "suite",
      rows: [
        {
          id: "s1",
          name: "Under 6 tool calls",
          kind: "Field check",
          enabled: true,
          builtIn: false,
          passRate: 1,
          trend: [1],
          href: "/s1",
        },
      ],
    }),
  );
  assert.match(visibleText(html), /Under 6 tool calls Field check On 100%/);
  assert.ok(!/bg-success[^"]*"[^>]*>On</.test(html));
});

test("RC-658: the scorer editor reads name, config, then when it passes; Delete is not a filled button", async () => {
  const { ScorerEditor } = await import("@/components/console/scorers/ScorerEditor");
  const html = render(
    createElement(ScorerEditor, {
      projectId: PROJECT_ID,
      backHref: "/b",
      scorer: {
        id: "s1",
        name: "Ends well",
        scope: "task",
        taskId: "t",
        enabled: true,
        goodThreshold: 0.5,
        version: 1,
        kind: "expression",
        config: { logic: { "==": [{ var: "endsWell" }, true] } },
      },
    }),
  );
  const text = visibleText(html);
  assert.ok(
    text.indexOf("Name") < text.indexOf("Rule (JSON)") &&
      text.indexOf("Rule (JSON)") < text.indexOf("Pass threshold (%)"),
  );
  assert.match(text, /Default: 50%/);
  assert.match(text, /Fields you can read/);
  assert.ok(!/bg-danger-fill[^"]*"[^>]*>Delete scorer/.test(html), "One primary: Save scorer.");
});
