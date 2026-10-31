import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowCollector } from "@/lib/readings/trace-signals/signals/workflow-run";
import type { StoredWorkflows } from "@/lib/readings/trace-signals/signals/workflow-stored";
import type { WorkflowInsights } from "@/lib/readings/trace-signals/workflows/decide";
import { many, wfTurn } from "@/lib/readings/trace-signals/workflows/test-fixtures";
import type { SignalRecord } from "@/lib/views/health/signals/claims-model";
import type { TaskFixLike } from "@/lib/views/tasks/issues";
import {
  buildTaskDetail,
  buildTaskList,
  type TasksInputs,
  weakestStep,
} from "@/lib/views/tasks/model";

const PROJECT = "11111111-1111-4111-8111-111111111111";

/** 30 runs of find > assign > update > notify where notify fails in 12, and 30 clean runs of list > open. */
function stored(): StoredWorkflows {
  const collector = createWorkflowCollector();
  const turns = [
    ...many(30, (i) =>
      wfTurn([
        "find",
        "assign",
        "update",
        i < 12 ? { tool: "notify", outcome: "error" } : "notify",
      ]),
    ),
    ...many(30, () => wfTurn(["list", "open"])),
  ];
  for (const turn of turns) collector.collect(turn);
  return collector.finish([
    { id: "wf-release", coreTools: ["assign", "find", "notify", "update"] },
    { id: "wf-browse", coreTools: ["list", "open"] },
  ]).stored;
}

function record(over: Partial<SignalRecord>): SignalRecord {
  return {
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
    ...over,
  };
}

function inputs(over: Partial<TasksInputs> = {}): TasksInputs {
  return {
    projectId: PROJECT,
    run: { windowDays: 30, finishedAt: new Date("2026-10-02T00:00:00Z"), turnsScanned: 80 },
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
    issues: [
      { record: record({}), proposalId: null },
      // A chain the agent reaches directly, and a chain of two of its own steps: the task itself, not issues in it.
      {
        record: record({
          id: "sig-4",
          kind: "sequence_chain",
          subjectKind: "tool_pair",
          subjectKey: "find>assign",
          subjectIds: ["find", "assign"],
          metrics: { route: "none", n: 30, turnsB: 30, shareOfB: 1 },
        }),
        proposalId: null,
      },
      {
        record: record({
          id: "sig-5",
          kind: "sequence_chain",
          subjectKind: "tool_pair",
          subjectKey: "assign>update",
          subjectIds: ["assign", "update"],
          metrics: { route: "workflow_skill", n: 30, turnsB: 30, shareOfB: 1 },
        }),
        proposalId: null,
      },
      {
        record: record({
          id: "sig-2",
          kind: "latency_outlier",
          subjectKind: "tool",
          subjectKey: "open",
          subjectIds: ["open"],
          metrics: {},
        }),
        proposalId: "fix-9",
      },
      {
        record: record({
          id: "sig-3",
          kind: "dead_tool",
          subjectKind: "project",
          subjectKey: "project",
          subjectIds: [],
          metrics: { dead: 2 },
        }),
        proposalId: null,
      },
    ],
    insights: null,
    fixes: [
      {
        id: "fix-1",
        kind: "tighten_schema",
        headline: "Describe notify's arguments.",
        toolIds: ["notify"],
        workflowId: null,
      },
      {
        id: "fix-2",
        kind: "compose_chain",
        headline: "One tool for the release.",
        toolIds: ["find", "assign", "update", "notify"],
        workflowId: "wf-release",
      },
      {
        id: "fix-3",
        kind: "deprecate_tool",
        headline: "Retire legacy_export.",
        toolIds: ["legacy_export"],
        workflowId: null,
      },
    ],
    recorded: null,
    topics: null,
    price: null,
    ...over,
  };
}

test("the list: one row per task, busiest first, with its status, finish rate and weakest step", () => {
  const model = buildTaskList(inputs());
  assert.equal(model.state, "ready");
  assert.deepEqual(
    model.rows.map((row) => [row.id, row.name, row.status, row.runs]),
    [
      ["wf-release", "Ship a release", "failing", 30],
      ["wf-browse", "list > open", "healthy", 30],
    ],
  );
  const release = model.rows[0]!;
  // Equal runs: the palette breaks the tie by id (lib/tasks/palette.ts), the list by status.
  assert.equal(release.color, "chart-5");
  assert.equal(model.rows[1]?.color, "chart-1");
  assert.equal(release.share, 30 / 80);
  assert.equal(release.finishRate, 18 / 30);
  assert.deepEqual(release.weakest, {
    toolId: "notify",
    label: "Notify team",
    failures: 12,
    calls: 30,
    failureShare: 0.4,
  });
  assert.equal(release.correctionsPer100, 40, "12 give-ups over 30 runs, read from the steps");
  assert.equal(release.issues, 1, "its own issue; the project-wide one is no task's");
  assert.equal(release.fixes, 2, "the schema fix on its tool and the fix that composes it");
  assert.equal(release.fixesHref, `/project/${PROJECT}/improvement/fixes?task=wf-release`);
  assert.equal(release.topics, null, "intents not assigned yet");
  assert.deepEqual(
    release.steps?.map((step) => step.label),
    ["find", "assign", "update", "Notify team"],
    "its steps, in their usual order, by name",
  );
  const browse = model.rows[1]!;
  assert.equal(browse.issues, 1, "an issue on one of its tools");
  assert.equal(browse.weakest, null);
  assert.deepEqual(model.stats, {
    tasks: 2,
    runsInTasks: 60,
    allRuns: 80,
    finishRate: 48 / 60,
    correctionsPer100: 20,
    correctionsRecorded: false,
  });
  assert.deepEqual(model.unserved, { measured: false, asks: [], runs: 0 });
});

test("recorded self-corrections win over the ones read from steps, for every task alike", () => {
  const model = buildTaskList(
    inputs({ recorded: { byTask: new Map([["wf-browse", { asked_again: 3, phrase: 3 }]]) } }),
  );
  const byId = new Map(model.rows.map((row) => [row.id, row]));
  assert.equal(byId.get("wf-browse")?.correctionsPer100, 20);
  assert.equal(byId.get("wf-release")?.correctionsPer100, 0, "recorded and none for it");
  assert.equal(model.stats.correctionsPer100, 10);
});

test("intents served, top two on the list, with how many in all", () => {
  const topics = new Map([
    [
      "wf-release",
      [
        { id: "t1", name: "Release notes", runs: 20 },
        { id: "t2", name: "Hotfixes", runs: 6 },
        { id: "t3", name: "Rollbacks", runs: 2 },
      ],
    ],
  ]);
  const model = buildTaskList(inputs({ topics }));
  assert.deepEqual(
    model.rows[0]?.topics?.map((topic) => topic.name),
    ["Release notes", "Hotfixes"],
  );
  assert.equal(model.rows[0]?.topicCount, 3);
  assert.deepEqual(model.rows[1]?.topics, [], "assigned, none for this task");
});

test("runs that asked for a task and called no tool count as unfinished", () => {
  const insights: WorkflowInsights = {
    version: 3,
    asksSeen: 40,
    judged: 40,
    unclear: 0,
    placed: { "wf-browse": { turns: 35, outside: 10, outsideWithErrors: 4 } },
    unserved: [
      {
        label: "export pdf",
        turns: 7,
        samples: ["export the board as a pdf"],
        turnIds: ["r1"],
        reason: "no_tool",
      },
    ],
    sources: { user: 40, search: 0 },
  };
  const model = buildTaskList(inputs({ insights }));
  const browse = model.rows.find((row) => row.id === "wf-browse")!;
  assert.equal(browse.finishRate, 30 / 36, "6 asked for it and called no tool");
  assert.equal(browse.status, "watch", "finishes under 90% without an issue raised");
  assert.deepEqual(model.unserved.measured, true);
  assert.equal(model.unserved.runs, 7);
  assert.equal(model.unserved.asks[0]?.reason, "no_tool");
});

test("before a reading, when runs are mixed, and when nothing repeats", () => {
  assert.equal(buildTaskList(inputs({ run: null })).state, "no_reading");
  const mixed = {
    ...stored(),
    items: [],
    basis: { basis: "none", blocked: "mixed_runs", excludedRuns: 40, since: null, mixed: true },
  };
  const blocked = buildTaskList(inputs({ stored: mixed }));
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.blocked, "mixed_runs");
  assert.equal(buildTaskList(inputs({ stored: { ...stored(), items: [] } })).state, "no_tasks");
  assert.equal(
    buildTaskList(inputs({ stored: { junk: true } })).state,
    "no_reading",
    "stored JSON is untrusted",
  );
});

test("one task: its steps in order with the failing one marked, its numbers, issues and fixes", () => {
  const detail = buildTaskDetail(inputs(), "wf-release")!;
  assert.equal(detail.name, "Ship a release");
  assert.equal(detail.status, "failing");
  assert.match(
    detail.statusLine,
    /^Runs of Ship a release fail 40% of the time, most often at Notify team\.$/,
  );
  assert.deepEqual(
    detail.steps.map((step) => [step.position, step.label, step.calls, step.failures, step.mark]),
    [
      [1, "find", 30, 0, null],
      [2, "assign", 30, 0, null],
      [3, "update", 30, 0, null],
      [4, "Notify team", 30, 12, "failing"],
    ],
  );
  assert.deepEqual(detail.steps[3]?.next, [{ toolId: null, label: "Run ends", share: 1 }]);
  assert.deepEqual(detail.steps[0]?.next, [{ toolId: "assign", label: "assign", share: 1 }]);
  assert.equal(detail.steps[3]?.gaveUp, 12);
  assert.deepEqual(detail.flow.edges, [
    { a: "find", b: "assign", n: 30, na: 30 },
    { a: "assign", b: "update", n: 30, na: 30 },
    { a: "update", b: "notify", n: 30, na: 30 },
  ]);
  assert.equal(detail.finishRate, 0.6);
  assert.equal(detail.recoveredRuns, 0);
  assert.equal(detail.callsPerRun, 4);
  assert.deepEqual(detail.cost, { kind: "none" });
  assert.deepEqual(
    detail.issues.map((issue) => [
      issue.id,
      issue.title,
      issue.family,
      issue.figure.display,
      issue.onTask,
      issue.tools,
      issue.action,
    ]),
    [["sig-1", "Runs that fail partway", "failing", "40%", true, [], null]],
    "the chain of its own steps is left out; failing runs name no change to make, so no button",
  );
  assert.deepEqual(
    detail.fixes.map((fix) => [
      fix.kind,
      fix.kindLabel,
      fix.tools.map((tool) => tool.label),
      fix.href,
    ]),
    [
      [
        "schema",
        "Tighten a schema",
        ["Notify team"],
        `/project/${PROJECT}/improvement/fixes?peek=craft%3Afix-1`,
      ],
      [
        "combine",
        "Combine steps",
        ["find", "assign", "update", "Notify team"],
        `/project/${PROJECT}/improvement/fixes?peek=craft%3Afix-2`,
      ],
    ],
    "without Fixes' model, the drafts on its tools",
  );
  assert.equal(detail.watch, null, "failing, not watched");
  assert.deepEqual(
    detail.corrections?.rows.map((row) => [row.label, row.count]),
    [
      ["Retried", 0],
      ["Switched tools", 0],
      ["Gave up", 12],
      ["Searched again", 0],
    ],
    "from steps alone, asked again and apologies are not measured",
  );
  assert.equal(detail.examples[0]?.why, "failed");
  assert.equal(detail.order.fixed, true);
});

test("an issue linked to a drafted fix opens it; a tool's issue names its tool", () => {
  const detail = buildTaskDetail(inputs(), "wf-browse")!;
  assert.deepEqual(
    detail.issues.map((issue) => [issue.id, issue.family, issue.onTask, issue.tools, issue.action]),
    [
      [
        "sig-2",
        "slow",
        false,
        [{ id: "open", label: "open" }],
        { kind: "fix", label: "Fix", href: `/project/${PROJECT}/improvement/fixes?peek=fix-9` },
      ],
    ],
  );
  assert.equal(detail.status, "healthy");
  assert.equal(detail.statusLine, "Finishes 100% of its runs.");
});

function fix(over: Partial<TaskFixLike> & Pick<TaskFixLike, "id">): TaskFixLike {
  return {
    aliases: [],
    kind: "schema",
    kindLabel: "Tighten a schema",
    title: "Tighten notify's schema",
    source: "craft",
    subject: { tools: [], tasks: [], topics: [] },
    issues: [],
    ...over,
  };
}

const task = (id: string) => ({ id, label: id, color: null, href: `/t/${id}` });
const tool = (id: string) => ({ id, label: id, href: `/c/${id}` });

test("with Fixes' model: a task lists and counts Fixes' own, a description fix goes to Quality › Descriptions, an issue opens the fix that resolves it", () => {
  const fixes = [
    fix({
      id: "craft:c1",
      aliases: ["issue:sig-1"],
      subject: { tools: [tool("notify")], tasks: [task("wf-release")], topics: [] },
    }),
    fix({
      id: "rewrite:mq-1",
      kind: "rewrite",
      kindLabel: "Rewrite a description",
      source: "rewrite",
      aliases: ["issue:sig-2"],
      subject: { tools: [tool("open")], tasks: [task("wf-browse")], topics: [] },
    }),
    fix({
      id: "issue:sig-9",
      kind: "rewrite",
      kindLabel: "Rewrite a description",
      source: "issue",
      subject: { tools: [tool("list")], tasks: [task("wf-browse")], topics: [] },
    }),
  ];
  const list = buildTaskList(inputs(), { fixes });
  assert.deepEqual(
    list.rows.map((row) => [row.id, row.fixes]),
    [
      ["wf-release", 1],
      ["wf-browse", 2],
    ],
    "the count its Fixes link lands on",
  );

  const release = buildTaskDetail(inputs(), "wf-release", { fixes })!;
  assert.deepEqual(
    release.fixes.map((one) => [one.id, one.href]),
    [["craft:c1", `/project/${PROJECT}/improvement/fixes?peek=craft%3Ac1`]],
  );
  assert.deepEqual(release.issues[0]?.action, {
    kind: "fix",
    label: "Fix",
    href: `/project/${PROJECT}/improvement/fixes?peek=craft%3Ac1`,
  });

  const browse = buildTaskDetail(inputs(), "wf-browse", { fixes })!;
  assert.deepEqual(
    browse.fixes.map((one) => [one.id, one.href]),
    [
      ["rewrite:mq-1", `/project/${PROJECT}/quality/descriptions?peek=rewrite%3Amq-1`],
      ["issue:sig-9", `/project/${PROJECT}/quality/descriptions?tool=list`],
    ],
  );
  assert.deepEqual(browse.issues[0]?.action, {
    kind: "description",
    label: "Update description",
    href: `/project/${PROJECT}/quality/descriptions?peek=rewrite%3Amq-1`,
  });

  const unresolved = buildTaskDetail(inputs(), "wf-release", { fixes: [] })!;
  assert.equal(unresolved.issues[0]?.action, null, "Fixes was read and nothing resolves it");
  assert.deepEqual(unresolved.fixes, []);
});

test("cost is measured from linked model calls, else estimated from the project's round-trip price", () => {
  const estimated = buildTaskDetail(
    inputs({
      price: { ms: 1_200, usd: 0.01, inputTokens: null, outputTokens: null, modelCalls: 500 },
    }),
    "wf-browse",
  )!;
  assert.equal(estimated.cost.kind, "estimated");
  if (estimated.cost.kind === "estimated") {
    assert.equal(estimated.cost.callsPerRun, 2);
    assert.ok(Math.abs(estimated.cost.perRun - 0.02) < 1e-9);
    assert.ok(Math.abs(estimated.cost.total - 0.6) < 1e-9);
  }
  const collector = createWorkflowCollector();
  for (const turn of many(25, () => ({
    ...wfTurn(["list", "open"]),
    linked: {
      modelCalls: 3,
      costUsd: 0.04,
      modelMs: 900,
      inputTokens: 100,
      outputTokens: 20,
      startedAt: new Date(),
      endedAt: new Date(),
    } as never,
  })))
    collector.collect(turn);
  const linked = buildTaskDetail(
    inputs({ stored: collector.finish([{ id: "wf-browse", coreTools: ["list", "open"] }]).stored }),
    "wf-browse",
  )!;
  assert.deepEqual(linked.cost, {
    kind: "measured",
    perRun: 0.04,
    total: 1,
    runs: 25,
    modelCalls: 3,
  });
});

test("a run stored before tasks were read step by step still lists its steps, without numbers", () => {
  const old = stored();
  const bare = { ...old, items: old.items.map(({ reading: _reading, ...item }) => item) };
  const detail = buildTaskDetail(inputs({ stored: bare }), "wf-release")!;
  assert.equal(detail.hasReading, false);
  assert.deepEqual(
    detail.steps.map((step) => step.toolId),
    ["find", "assign", "update", "notify"],
  );
  assert.equal(detail.finishRate, 0.6, "health still knows the finish rate");
  assert.equal(buildTaskList(inputs({ stored: bare })).rows[0]?.weakest, null);
});

test("an unknown task is no page", () => {
  assert.equal(buildTaskDetail(inputs(), "wf-gone"), null);
});

test("the weakest step skips helpers and steps that never failed", () => {
  const reading = stored().items.find((item) => item.id === "wf-release")!.reading!;
  assert.equal(weakestStep(reading, (id) => id)?.toolId, "notify");
  assert.equal(
    weakestStep(null, (id) => id),
    null,
  );
});
