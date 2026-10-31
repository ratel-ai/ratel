// First: lets node load the components' stylesheet imports.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { SessionView } from "@/components/console/tasks/SessionView";
import { TaskGone } from "@/components/console/tasks/TaskGone";
import { IssuePanelBody, StepPanelBody } from "@/components/console/tasks/TaskPanels";
import { TaskSkeleton, TasksSkeleton } from "@/components/console/tasks/TasksSkeleton";
import { TasksView } from "@/components/console/tasks/TasksView";
import { TaskView } from "@/components/console/tasks/TaskView";
import type { TraceTurnRow, TraceTurnStepRow } from "@/lib/ledger/schema";
import { createWorkflowCollector } from "@/lib/readings/trace-signals/signals/workflow-run";
import { many, wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";
import type { SignalRecord } from "@/lib/views/health/signals/claims-model";
import { buildTaskDetail, buildTaskList, type TasksInputs } from "@/lib/views/tasks/model";
import type { ExampleRun } from "@/lib/views/tasks/queries";
import { attributeValues, PROJECT_ID, render, visibleText } from "@/lib/views/tasks/test-support";

const NOW = new Date("2026-10-02T12:00:00Z");
const ROOT = `/project/${PROJECT_ID}`;
const ASK = "Ship release 4.2 and tell the team";

/** An anchor to `href`, whatever order its attributes come in (`&` as React escapes it). */
function anchor(href: string, more = ""): string {
  const escaped = href.replace(/&/g, "&amp;").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `<a(?=[^>]*href="${escaped}")${more ? `(?=[^>]*${more})` : ""}[^>]*>`;
}

function stored() {
  const collector = createWorkflowCollector();
  for (const turn of [
    ...many(30, (i) =>
      wfTurn([
        "find",
        "assign",
        "update",
        i < 12 ? { tool: "notify", outcome: "error" } : "notify",
      ]),
    ),
    ...many(30, (i) => wfTurn(i < 6 ? ["list", "lookup", "open"] : ["list", "open"])),
  ])
    collector.collect(turn);
  return collector.finish([
    { id: "wf-release", coreTools: ["assign", "find", "notify", "update"] },
    { id: "wf-browse", coreTools: ["list", "open"] },
  ]).stored;
}

const failing: SignalRecord = {
  id: "sig-1",
  kind: "workflow_failing",
  status: "open",
  tier: "deterministic",
  subjectKind: "workflow",
  subjectKey: "wf-release",
  subjectIds: ["find", "assign", "update", "notify"],
  entryKind: "tool",
  severity: 0.3,
  impact: 12,
  n: 30,
  metrics: {
    completion: 0.6,
    runs: 30,
    failedRuns: 12,
    failingStep: "notify",
    failingStepShare: 1,
  },
  turnIds: [],
  traceEventIds: [],
  totalTurns: 12,
  turnSourceMix: { declared: 0, inferred: 30, otlp: 0 },
  firstSeenAt: "2026-10-01T00:00:00.000Z",
  lastSeenAt: "2026-10-02T00:00:00.000Z",
};

function inputs(over: Partial<TasksInputs> = {}): TasksInputs {
  return {
    projectId: PROJECT_ID,
    run: { windowDays: 30, finishedAt: new Date("2026-10-02T09:00:00Z"), turnsScanned: 80 },
    stored: stored(),
    labels: new Map([
      [
        "wf-release",
        {
          name: "Ship a release",
          description: "Finds the work, assigns it, updates it and tells the team.",
          icon: "rocket",
        },
      ],
    ]),
    names: new Map([["notify", "Notify team"]]),
    issues: [{ record: failing, proposalId: null }],
    insights: null,
    fixes: [
      {
        id: "fix-1",
        kind: "tighten_schema",
        headline: "Describe notify's arguments.",
        toolIds: ["notify"],
        workflowId: null,
      },
    ],
    recorded: null,
    topics: null,
    price: null,
    ...over,
  };
}

/** DESIGN.md's rules and the product's nouns, on every render below. */
function assertHouseStyle(html: string, where: string) {
  const text = visibleText(html);
  assert.doesNotMatch(text, /—/, `${where}: no em dash`);
  assert.doesNotMatch(
    html,
    /text-\[(?:9|10|11)px\]|uppercase tracking/,
    `${where}: nothing under 12 px, no eyebrows`,
  );
  assert.doesNotMatch(
    text,
    /\b[Ww]orkflows?\b|Tool craft|ask group|\b[Ss]uggestions?\b|\b[Ss]ignals?\b|\b[Tt]opics?\b/,
    `${where}: the product's nouns only`,
  );
  assert.doesNotMatch(html, /coral|cream|forest-|warm-muted/, `${where}: semantic tokens only`);
}

test("Tasks: one header, four numbers, then every task over its steps as pins, with its status, weakest step, issues and fixes", () => {
  const html = render(
    createElement(TasksView, { projectId: PROJECT_ID, model: buildTaskList(inputs()), now: NOW }),
  );
  assertHouseStyle(html, "list");
  assert.doesNotMatch(visibleText(html), /\brequests?\b/i, "an ask, never a request");
  assert.equal(html.match(/<h1/g)?.length, 1);
  assert.match(
    html,
    new RegExp(`href="${ROOT}/health"[^>]*>Agent health</a>[^]*<h1[^>]*>Tasks</h1>`),
    "Agent health is the crumb",
  );
  assert.doesNotMatch(
    html,
    /the tools it runs, in order/,
    "what a task is shows in its pins, not in a sentence",
  );
  for (const label of ["Tasks", "Runs in a task", "Finish rate"])
    assert.match(html, new RegExp(`<dt[^>]*>${label}</dt>`));
  assert.match(
    html,
    new RegExp(
      `<dt[^>]*>${anchor(`${ROOT}/health/self-corrections`)}Self-corrections per 100 runs</a></dt>`,
    ),
    "the number opens its page",
  );
  assert.match(html, />75% of 80 runs</, "runs in a task, as a share of all runs");
  for (const header of [
    "Task",
    "Status",
    "Runs",
    "Finish rate",
    "Weakest step",
    "Intents",
    "Issues and fixes",
  ]) {
    assert.match(html, new RegExp(`<th[^>]*>${header}</th>`), header);
  }
  assert.match(
    html,
    /<th[^>]*><span[^>]*>Self-corrections<span[^>]*>per 100 runs<\/span><\/span><\/th>/,
  );
  assert.deepEqual(
    [...html.matchAll(/data-task-row="([^"]+)"/g)].map((m) => m[1]),
    ["wf-release", "wf-browse", "unserved"],
  );
  assert.match(html, new RegExp(`href="${ROOT}/health/tasks/wf-release"[^>]*>Ship a release</a>`));
  assert.match(
    html,
    /data-task-color="chart-5" class="[^"]*rounded-\[2px\]/,
    "the task's color, the square TaskPin wears",
  );
  // Its steps as tool pins joined by arrows: two shown, the rest folded (three from the widest screens).
  assert.match(
    html,
    /<ol aria-label="Steps, in order"[^>]*data-step-pins="4">[^]*?lucide-wrench[^]*?>find<\/span>[^]*?lucide-arrow-right[^]*?>assign<\/span>/,
  );
  assert.match(
    html,
    /<span aria-hidden="true">\+2<\/span><span class="sr-only">and 2 more<\/span>/,
    "folded after two",
  );
  assert.match(html, /data-task-status="failing"[^]*Failing/);
  assert.match(
    html,
    new RegExp(
      `data-task-weakest="notify" data-weakest-failing="true">${anchor(`${ROOT}/health/tasks/wf-release?peek=step%3Anotify`, 'class="[^"]*border-danger')}<svg[^]*?>Notify team</span></a><span[^>]*>fails 40%`,
    ),
    "the weakest step is a pin that opens it on the task's page, in the danger color past the Watch line",
  );
  assert.match(
    html,
    new RegExp(
      `${anchor(`${ROOT}/health/tasks/wf-release#issues`, 'data-task-issues="1"')}<svg[^]*?lucide-circle-alert[^]*?</svg>1<span class="sr-only"> issue</span>`,
    ),
  );
  assert.match(
    html,
    new RegExp(
      `${anchor(`${ROOT}/improvement/fixes?task=wf-release`, 'data-task-fixes="1"')}<svg[^]*?lucide-hammer[^]*?</svg>1<span class="sr-only"> fix</span>`,
    ),
  );
  assert.match(html, />Not measured</, "intents before they are assigned");
  assert.match(html, /Asks no task handles[^]*Not measured yet/);
});

test("the intents a task serves are pins that open on Intents: the first, and how many more", () => {
  const topics = new Map([
    [
      "wf-release",
      [
        { id: "t-1", name: "Release notes", runs: 20 },
        { id: "t-2", name: "Hotfixes", runs: 6 },
        { id: "t-3", name: "Rollbacks", runs: 2 },
      ],
    ],
  ]);
  const html = render(
    createElement(TasksView, {
      projectId: PROJECT_ID,
      model: buildTaskList(inputs({ topics })),
      now: NOW,
    }),
  );
  assertHouseStyle(html, "intents");
  assert.match(
    html,
    new RegExp(
      `${anchor(`${ROOT}/intents?peek=t-1`)}<svg[^]*?lucide-message-square-text[^]*?>Release notes</span></a>`,
    ),
  );
  assert.match(
    html,
    /<span aria-hidden="true">\+2<\/span><span class="sr-only">and 2 more intents<\/span>/,
  );
  assert.ok(
    !attributeValues(html).some((value) => value.includes("Release notes")),
    "an intent's name is text, never an attribute",
  );
});

test("the states before a reading, when runs mix, and when nothing repeats", () => {
  for (const [model, title] of [
    [buildTaskList(inputs({ run: null })), "No tasks yet"],
    [
      buildTaskList(
        inputs({
          stored: {
            ...stored(),
            items: [],
            basis: {
              basis: "none",
              blocked: "mixed_runs",
              excludedRuns: 40,
              since: null,
              mixed: true,
            },
          },
        }),
      ),
      "Runs mix several asks",
    ],
    [buildTaskList(inputs({ stored: { ...stored(), items: [] } })), "No task repeats yet"],
  ] as const) {
    const html = render(createElement(TasksView, { projectId: PROJECT_ID, model, now: NOW }));
    assertHouseStyle(html, title);
    assert.match(html, new RegExp(title.replace(/'/g, "&#x27;")));
    assert.doesNotMatch(html, /<table/, `${title}: a designed state where the table would be`);
    assert.match(html, new RegExp(`href="${ROOT}/health"[^>]*>Open Agent health`));
  }
});

function release() {
  const detail = buildTaskDetail(inputs(), "wf-release")!;
  const [first] = detail.examples;
  const examples = new Map<string, ExampleRun>([
    [
      first!.turnId,
      {
        turnId: first!.turnId,
        sessionId: "sess-9",
        startedAt: new Date("2026-10-01T10:00:00Z"),
        endedAt: new Date("2026-10-01T10:00:05Z"),
        calls: 4,
        failures: 1,
        steps: [
          { toolId: "find", label: "find", failed: false },
          { toolId: "notify", label: "Notify team", failed: true },
          { toolId: "notify", label: "Notify team", failed: false },
        ],
        status: "recovered",
        ask: { text: ASK, source: "user_message" },
      },
    ],
  ]);
  return { detail, examples };
}

test("a task's page: a header in its color, its numbers, its steps as a drawing", () => {
  const { detail, examples } = release();
  const html = render(
    createElement(TaskView, { projectId: PROJECT_ID, task: detail, examples, now: NOW }),
    { pathname: `${ROOT}/health/tasks/wf-release` },
  );
  assertHouseStyle(html, "task");
  assert.match(
    html,
    new RegExp(
      `href="${ROOT}/health/tasks"[^>]*>Tasks</a>[^]*<h1[^>]*>[^]*?data-task-color="chart-5" class="[^"]*bg-chart-5[^]*?Ship a release`,
    ),
    "the crumb leads back; the title wears its color",
  );
  assert.match(html, /data-task-status="failing"/);
  for (const label of ["Runs", "Finish rate", "Typical run"])
    assert.match(html, new RegExp(`<dt[^>]*>${label}</dt>`));
  assert.match(
    html,
    new RegExp(
      `<dt[^>]*>${anchor(`${ROOT}/health/self-corrections?task=wf-release`)}Self-corrections per 100 runs</a></dt>`,
    ),
  );
  assert.doesNotMatch(html, /Cost per run/, "no cost without model calls, so no stat to say so");
  assert.match(
    html,
    /data-status-reason="">60%<svg[^>]*lucide-circle-x/,
    "the status mark sits by the number that explains it",
  );
  assert.doesNotMatch(html, /role="alert"/, "no sentence above the drawing");

  // Pins joined by a line in the task's color; the failing step in the danger color, with its word.
  assert.deepEqual(
    [...html.matchAll(/data-task-step="([^"]+)"/g)].map((m) => m[1]),
    ["find", "assign", "update", "notify"],
  );
  assert.equal(
    html.match(/data-step-line="" class="[^"]*bg-chart-5/g)?.length,
    3,
    "a line between each pair of steps",
  );
  assert.match(
    html,
    /data-step-mark="failing"[^]*?href="[^"]*\?peek=step%3Anotify"[^]*?border-danger[^]*?>Notify team<\/span>[^]*?Fails most/,
  );
  assert.match(html, /role="meter" aria-label="Fails 40% of its calls"/);
  assert.match(html, /Same order in 100% of runs/);
  assert.doesNotMatch(
    html,
    /How runs move between steps/,
    "a straight line of steps needs no second drawing",
  );
});

test("a task's page: self-corrections as one strip, issues, fixes and intents as compact rows", () => {
  const { detail, examples } = release();
  const html = render(
    createElement(TaskView, { projectId: PROJECT_ID, task: detail, examples, now: NOW }),
    { pathname: `${ROOT}/health/tasks/wf-release` },
  );
  assert.match(
    html,
    new RegExp(
      `${anchor(`${ROOT}/health/self-corrections?task=wf-release`)}[^]*?Self-corrections[^]*?data-correction-kind="gave_up_after_error"><svg[^]*?lucide-circle-slash[^]*?>12</span><span[^>]*>Gave up`,
    ),
  );
  assert.doesNotMatch(
    html,
    /data-correction-kind="retry_after_error"/,
    "kinds that did not happen are left out",
  );

  // An issue: its family's mark, a title that opens its panel, one number; no button when there is no change to make.
  assert.match(html, /id="issues"/);
  assert.match(
    html,
    /data-task-issue="workflow_failing" data-issue-family="failing"><svg[^]*?lucide-route-off[^]*?href="[^"]*\?peek=issue%3Asig-1"[^>]*>Runs that fail partway<\/a>[^]*?>40%</,
  );
  assert.doesNotMatch(html, /data-issue-action=/);
  assert.doesNotMatch(html, /Look at the failed runs/, "the sentences wait in the panel");

  // A fix: its kind's mark and name, and the tools it changes.
  assert.match(
    html,
    new RegExp(
      `${anchor(`${ROOT}/improvement/fixes?peek=craft%3Afix-1`, 'data-fix-kind="schema"')}<svg[^]*?lucide-braces[^]*?Tighten a schema[^]*?>Notify team</span>`,
    ),
  );
  assert.match(html, new RegExp(`${anchor(`${ROOT}/improvement/fixes?task=wf-release`)}All fixes`));
  assert.match(html, /Intents it serves[^]*Not measured yet/);
});

test("a task's page: example runs as how each ended, its calls as pins with repeats folded, and the way into Traces", () => {
  const { detail, examples } = release();
  const html = render(
    createElement(TaskView, { projectId: PROJECT_ID, task: detail, examples, now: NOW }),
    { pathname: `${ROOT}/health/tasks/wf-release` },
  );
  assert.match(
    html,
    /data-task-example="failed" data-example-status="recovered"><span[^>]*><svg[^]*?lucide-rotate-ccw[^]*?<\/svg>Recovered<\/span>/,
  );
  assert.match(
    html,
    /data-step-failed="true"><a?[^]*?>Notify team<\/span>[^]*?×2<\/span><span class="sr-only">, 2 times<\/span><\/span><span class="sr-only">, failed<\/span>/,
  );
  assert.match(html, />5\u00a0s</, "how long it took");
  assert.match(
    html,
    /<time dateTime="2026-10-01T10:00:00.000Z" title="Oct 1, 2026, 10:00:00\u00a0UTC">yesterday<\/time>/,
    "when, relative, with the absolute time on hover",
  );
  assert.match(html, new RegExp(`href="${ROOT}/traces/turns/[^"]+"[^>]*>[^]*Open in Traces`));
  assert.match(
    html,
    new RegExp(
      `<a(?=[^>]*href="${ROOT}/health/tasks/sessions/sess-9\\?tools=[^"]*&amp;task=wf-release")(?=[^>]*aria-label="Open the conversation")`,
    ),
  );
  assert.ok(visibleText(html).includes(ASK), "what was asked, read for the example");
  assert.ok(
    !attributeValues(html).some((value) => value.includes("Ship release 4.2")),
    "never in an attribute",
  );
});

test("a step's panel: its numbers, what came next and its neighbours", () => {
  const { detail } = release();
  const step = detail.steps.find((one) => one.toolId === "notify")!;
  const html = render(
    createElement(StepPanelBody, {
      projectId: PROJECT_ID,
      taskId: "wf-release",
      step,
      task: createElement("span", null, "the task's pin"),
      hasReading: true,
    }),
  );
  assertHouseStyle(html, "step panel");
  for (const label of [
    "Calls",
    "Fails",
    "Typical time",
    "Then waits",
    "Retried",
    "Switched tools",
    "Gave up",
  ])
    assert.match(html, new RegExp(`<dt[^>]*>(<svg[^]*?</svg>)?${label}</dt>`), label);
  assert.match(
    html,
    /the task&#x27;s pin<\/span><span>called in <span[^>]*>100%<\/span> of its runs/,
  );
  assert.match(html, /data-step-next=""[^]*lucide-flag[^]*Run ends[^]*100%/);
  assert.match(
    html,
    new RegExp(`href="${ROOT}/health/self-corrections\\?tool=notify&amp;task=wf-release"`),
  );
  assert.match(html, new RegExp(`href="${ROOT}/improvement/fixes\\?tool=notify"`));
  assert.match(html, new RegExp(`href="${ROOT}/catalogs/tools\\?q=notify&amp;highlight=notify"`));
});

test("an issue's panel: its number, what it is about, its sentences and what to do", () => {
  const { detail } = release();
  const html = render(
    createElement(IssuePanelBody, {
      projectId: PROJECT_ID,
      issue: detail.issues[0]!,
      task: createElement("span", null, "the task's pin"),
    }),
  );
  assertHouseStyle(html, "issue panel");
  assert.match(html, />40%<\/span>/);
  assert.match(html, /the task&#x27;s pin/, "on the task itself: its pin");
  assert.match(
    html,
    /Runs of Ship a release fail 40% of the time, most often at Notify team\./,
    "the sentence lives here",
  );
  assert.match(html, /What to do/);
  assert.match(
    html,
    new RegExp(`href="${ROOT}/health\\?peek=issue%3Asig-1"[^>]*>[^]*Open in Agent health`),
  );
});

test("a healthy task: no status mark, the tools some runs add after its steps, and no issue", () => {
  const html = render(
    createElement(TaskView, {
      projectId: PROJECT_ID,
      task: buildTaskDetail(inputs(), "wf-browse")!,
      examples: new Map(),
      now: NOW,
    }),
  );
  assertHouseStyle(html, "healthy task");
  assert.doesNotMatch(html, /role="alert"|role="note"|data-status-reason/);
  assert.match(
    html,
    /Sometimes adds[^]*data-task-side-step="lookup"[^]*href="[^"]*\?peek=step%3Alookup"[^]*>lookup<\/span>[^]*20%/,
  );
  assert.match(
    html,
    /How runs move between steps/,
    "runs leave the straight line: the second drawing earns its place",
  );
  assert.match(html, /No open issue on this task or its tools\./);
});

test("a conversation: its turns with the task's steps marked, each opening in Traces", () => {
  const at = new Date("2026-09-01T10:00:00Z");
  const turn = (id: string) =>
    ({
      id,
      projectId: PROJECT_ID,
      sessionId: "s1",
      startedAt: at,
      endedAt: at,
    }) as unknown as TraceTurnRow;
  const step = (turnId: string, ordinal: number, over: Partial<TraceTurnStepRow>) =>
    ({
      turnId,
      ordinal,
      kind: "invoke",
      targetType: "tool",
      targetId: null,
      outcome: "ok",
      tookMs: 12,
      hitCount: null,
      ...over,
    }) as unknown as TraceTurnStepRow;
  const html = render(
    createElement(SessionView, {
      projectId: PROJECT_ID,
      sessionId: "s1",
      names: { find: "Find task" },
      highlight: ["find"],
      crumbs: [
        { label: "Agent health", href: `${ROOT}/health` },
        { label: "Tasks", href: `${ROOT}/health/tasks` },
      ],
      backHref: `${ROOT}/health/tasks/wf-release`,
      backLabel: "Back to the task",
      turns: [
        {
          turn: turn("t1"),
          steps: [
            step("t1", 1, { kind: "search", targetType: null, hitCount: 3 }),
            step("t1", 2, { targetId: "find" }),
          ],
        },
        { turn: turn("t2"), steps: [step("t2", 1, { targetId: "assign", outcome: "error" })] },
      ],
    }),
  );
  assertHouseStyle(html, "session");
  assert.match(html, /<h1[^>]*>Session<\/h1>/);
  assert.match(html, /the task&#x27;s steps are marked/);
  assert.match(html, /data-step-marked="true"[^>]*>[^]*Find task/);
  assert.match(html, /data-step-outcome="error"[^]*, failed/);
  assert.match(html, new RegExp(`href="${ROOT}/traces/turns/t2"[^>]*>Open in Traces`));
  const empty = render(
    createElement(SessionView, {
      projectId: PROJECT_ID,
      sessionId: "none",
      names: {},
      turns: [],
      crumbs: [],
      backHref: `${ROOT}/health/tasks`,
      backLabel: "Back to Tasks",
    }),
  );
  assert.match(empty, /No closed turns[^]*Back to Tasks/);
});

test("a task the reading no longer finds is said in place, with the way back; loading mirrors the pages", () => {
  const gone = render(
    createElement(TaskGone, { projectId: PROJECT_ID, known: true, reading: true }),
  );
  assertHouseStyle(gone, "gone");
  assert.match(gone, /This task is not in the latest reading[^]*Open Tasks/);
  assert.match(
    render(createElement(TasksSkeleton)),
    /role="status"[^>]*>Loading tasks…[^]*data-tasks-skeleton=""/,
  );
  assert.match(
    render(createElement(TaskSkeleton)),
    /role="status"[^>]*>Loading the task…[^]*data-task-skeleton=""/,
  );
});
