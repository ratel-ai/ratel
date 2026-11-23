import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BuildInput,
  buildSelfCorrectionsPage,
  type CorrectionGroup,
  type CorrectionReads,
  exampleTraceHref,
  trendBucketDays,
  trendOf,
} from "@/lib/views/health/self-corrections/page-model";
import { NO_FILTERS } from "@/lib/views/health/self-corrections/paths";

const PROJECT = "p1";

function group(over: Partial<CorrectionGroup>): CorrectionGroup {
  return {
    kind: "retry_after_error",
    phraseCategory: null,
    phrase: null,
    toolId: "update_task",
    workflowId: null,
    topicId: null,
    events: 1,
    ...over,
  };
}

const GROUPS: CorrectionGroup[] = [
  group({ kind: "retry_after_error", toolId: "update_task", workflowId: "wf-a", events: 20 }),
  group({ kind: "switch_after_error", toolId: "update_task", workflowId: "wf-a", events: 10 }),
  group({
    kind: "gave_up_after_error",
    toolId: "link_pr",
    workflowId: "wf-b",
    events: 8,
    topicId: "topic-1",
  }),
  group({ kind: "asked_again", toolId: "link_pr", workflowId: null, events: 2 }),
  group({
    kind: "phrase",
    phraseCategory: "apology",
    phrase: "I'm sorry",
    toolId: "update_task",
    workflowId: "wf-a",
    events: 5,
  }),
  group({
    kind: "phrase",
    phraseCategory: "apology",
    phrase: "I'm sorry",
    toolId: null,
    workflowId: null,
    events: 1,
  }),
  group({
    kind: "phrase",
    phraseCategory: "admission",
    phrase: "My mistake",
    toolId: "skill:triage",
    workflowId: null,
    events: 2,
  }),
  group({ kind: "searched_again", toolId: null, workflowId: null, events: 2, topicId: "topic-1" }),
];

function reads(over: Partial<CorrectionReads> = {}): CorrectionReads {
  return {
    run: {
      computedAt: "2026-10-20T10:00:00.000Z",
      trust: { runs: "all", sessions: true },
      turnsWithReplies: 40,
    },
    current: { turns: 1_000, groups: GROUPS, failedCalls: 30, recoveredCalls: 21 },
    previous: { turns: 800, events: 24 },
    taskTurns: new Map([
      ["wf-a", 200],
      ["wf-b", 50],
    ]),
    topicTurns: new Map([["topic-1", 120]]),
    examples: [],
    issues: [],
    sentiment: null,
    ...over,
  };
}

function input(over: Partial<BuildInput> = {}): BuildInput {
  return {
    projectId: PROJECT,
    windowDays: 7,
    filters: NO_FILTERS,
    reads: reads(),
    names: {
      tools: new Map([
        ["update_task", "Update task"],
        ["triage", "Triage"],
      ]),
      tasks: new Map([
        ["wf-a", { name: "Update work", runs: 200 }],
        ["wf-b", { name: "Link a PR", runs: 50 }],
      ]),
      topics: new Map([["topic-1", "Release tracking"]]),
    },
    ...over,
  };
}

test("the page's state: not read yet, runs mixed together, no turns, or ready", () => {
  assert.equal(buildSelfCorrectionsPage(input({ reads: reads({ run: null }) })).state, "not_read");
  assert.equal(
    buildSelfCorrectionsPage(
      input({
        reads: reads({
          run: { computedAt: "x", trust: { runs: "none", sessions: false }, turnsWithReplies: 0 },
        }),
      }),
    ).state,
    "mixed_runs",
  );
  assert.equal(
    buildSelfCorrectionsPage(
      input({
        reads: reads({ current: { turns: 0, groups: [], failedCalls: 0, recoveredCalls: 0 } }),
      }),
    ).state,
    "no_turns",
  );
  assert.equal(buildSelfCorrectionsPage(input()).state, "ready");
});

test("header numbers: per 100 turns against the window before, recovered, asked again, gave up", () => {
  const page = buildSelfCorrectionsPage(input());
  assert.equal(page.events, 50);
  const [rate, recovered, asked, gaveUp] = page.stats;
  assert.deepEqual(rate, {
    label: "Per 100 turns",
    value: "5.0",
    hint: "3.0 in the 7 days before",
    delta: { value: "+2.0", direction: "up", good: false, label: "vs the 7 days before" },
  });
  assert.deepEqual(recovered, { label: "Recovered", value: "70%", hint: "21 of 30 failed calls" });
  assert.deepEqual(asked, {
    label: "Asked again next turn",
    value: "<1%",
    hint: "2 of 1,000 turns",
  });
  assert.deepEqual(gaveUp, { label: "Gave up", value: "8", hint: "27% of failed calls" });
  assert.equal(page.stats.length, 4, "no sentiment read, no fifth number");
});

test("without the window before, the rate says what it counts; fewer is good news", () => {
  const first = buildSelfCorrectionsPage(input({ reads: reads({ previous: null }) }));
  assert.deepEqual(first.stats[0], {
    label: "Per 100 turns",
    value: "5.0",
    hint: "50 in 1,000 turns",
  });
  const better = buildSelfCorrectionsPage(
    input({ reads: reads({ previous: { turns: 500, events: 50 } }) }),
  );
  assert.deepEqual(better.stats[0]?.delta, {
    value: "-5.0",
    direction: "down",
    good: true,
    label: "vs the 7 days before",
  });
  const thin = buildSelfCorrectionsPage(
    input({ reads: reads({ previous: { turns: 3, events: 0 } }) }),
  );
  assert.deepEqual(
    thin.stats[0],
    { label: "Per 100 turns", value: "5.0", hint: "50 in 1,000 turns" },
    "a handful of turns before is no baseline",
  );
  const noErrors = buildSelfCorrectionsPage(
    input({
      reads: reads({ current: { turns: 10, groups: [], failedCalls: 0, recoveredCalls: 0 } }),
    }),
  );
  assert.equal(noErrors.stats[1]?.value, "No errors");
  const mixedSessions = buildSelfCorrectionsPage(
    input({
      reads: reads({
        run: { computedAt: "x", trust: { runs: "all", sessions: false }, turnsWithReplies: 0 },
      }),
    }),
  );
  assert.equal(mixedSessions.stats[2]?.value, "Not measured");
});

test("a fifth number once sentiment is read on both sides", () => {
  const sentiment = {
    corrected: { negative: 12, measured: 24 },
    clean: { negative: 50, measured: 200 },
  };
  const page = buildSelfCorrectionsPage(input({ reads: reads({ sentiment }) }));
  assert.deepEqual(page.stats[4], {
    label: "Negative after one",
    value: "2.0×",
    hint: "50% of turns with a self-correction, 25% without",
  });
  const thin = buildSelfCorrectionsPage(
    input({
      reads: reads({ sentiment: { ...sentiment, corrected: { negative: 3, measured: 6 } } }),
    }),
  );
  assert.equal(thin.stats.length, 4, "too few turns with a self-correction to compare");
});

test("by kind: the eight plain kinds, phrases unmeasured without captured replies", () => {
  const page = buildSelfCorrectionsPage(input());
  assert.deepEqual(
    page.byKind.map((row) => [row.label, row.events]),
    [
      ["Retried after an error", 20],
      ["Switched tools", 10],
      ["Gave up", 8],
      ["Searched again", 2],
      ["Asked again", 2],
      ["Apologized", 6],
      ["Conceded", 2],
      ["Backtracked", 0],
    ],
  );
  assert.ok(page.byKind.every((row) => row.measured));
  const noReplies = buildSelfCorrectionsPage(
    input({
      reads: reads({
        run: { computedAt: "x", trust: { runs: "all", sessions: true }, turnsWithReplies: 0 },
        current: {
          turns: 100,
          groups: GROUPS.filter((g) => g.kind !== "phrase"),
          failedCalls: 1,
          recoveredCalls: 1,
        },
      }),
    }),
  );
  assert.deepEqual(
    noReplies.byKind.filter((row) => !row.measured).map((row) => row.kind),
    ["apologized", "conceded", "backtracked"],
  );
  assert.equal(noReplies.phrases.captured, false);
});

test("after which tool call: most first, its main kind, its task, and links to Catalog and the filter", () => {
  const page = buildSelfCorrectionsPage(
    input({ windowDays: 30, filters: { ...NO_FILTERS, topic: "topic-1" } }),
  );
  const [first, second, third] = page.byTool;
  assert.equal(first?.name, "Update task");
  assert.equal(first?.events, 35);
  assert.equal(first?.mainKind, "Retried after an error");
  assert.deepEqual(first?.task, {
    id: "wf-a",
    name: "Update work",
    href: "/project/p1/health/tasks/wf-a",
  });
  assert.equal(
    first?.catalogHref,
    "/project/p1/catalogs/tools?q=update_task&highlight=update_task",
  );
  assert.equal(
    first?.filterHref,
    "/project/p1/health/self-corrections?days=30&tool=update_task&topic=topic-1",
  );
  assert.deepEqual(
    [first?.entryId, first?.entryKind],
    ["update_task", "tool"],
    "its pin's id and kind",
  );
  assert.equal(second?.name, "link_pr", "a tool the catalog does not know keeps its id");
  assert.equal(third?.name, "Triage");
  assert.deepEqual([third?.entryId, third?.entryKind], ["triage", "skill"]);
  assert.equal(third?.catalogHref, "/project/p1/catalogs/skills?skill=triage");
  assert.equal(page.withoutTool, 3);
});

test("by task: color for the busiest, rate per 100 runs, and what no task handles", () => {
  const page = buildSelfCorrectionsPage(input());
  assert.deepEqual(
    page.byTask.map((row) => [row.name, row.color, row.events, row.turns, row.per100]),
    [
      ["Update work", "chart-1", 35, 200, 17.5],
      ["Link a PR", "chart-5", 8, 50, 16],
    ],
  );
  assert.equal(page.byTask[0]?.href, "/project/p1/health/tasks/wf-a");
  assert.deepEqual(page.unplaced, { events: 7, turns: 750 });
});

test("by intent, once turns have intents; null before", () => {
  const page = buildSelfCorrectionsPage(input());
  assert.deepEqual(
    page.byTopic?.map((row) => [row.name, row.events, row.turns, row.href]),
    [["Release tracking", 10, 120, "/project/p1/intents?peek=topic-1"]],
  );
  const none = buildSelfCorrectionsPage(
    input({
      reads: reads({
        topicTurns: new Map(),
        current: {
          turns: 1_000,
          groups: GROUPS.map((g) => ({ ...g, topicId: null })),
          failedCalls: 0,
          recoveredCalls: 0,
        },
      }),
    }),
  );
  assert.equal(none.byTopic, null);
});

test("top phrases: one row per phrase across tools and tasks, most first", () => {
  const page = buildSelfCorrectionsPage(input());
  assert.deepEqual(
    page.phrases.top.map((row) => [row.phrase, row.kindLabel, row.events]),
    [
      ["I'm sorry", "Apologized", 6],
      ["My mistake", "Conceded", 2],
    ],
  );
  assert.equal(page.phrases.captured, true);
});

test("examples: what came before, and Traces at the run or the step", () => {
  const at = new Date("2026-10-19T10:00:00Z");
  const page = buildSelfCorrectionsPage(
    input({
      reads: reads({
        examples: [
          {
            id: "e1",
            turnId: "t1",
            kind: "phrase",
            phraseCategory: "retry",
            phrase: "Let me try that again",
            toolId: "update_task",
            toolOutcome: "error",
            occurredAt: at,
            hasText: true,
            turnKey: `otlp:${"a".repeat(32)}`,
            focusEventId: "ev1",
          },
          {
            id: "e2",
            turnId: "t2",
            kind: "asked_again",
            phraseCategory: null,
            phrase: null,
            toolId: null,
            toolOutcome: null,
            occurredAt: at,
            hasText: false,
            turnKey: "declared:x",
            focusEventId: "ev2",
          },
        ],
      }),
    }),
  );
  assert.deepEqual(
    page.examples.map((e) => [e.kindLabel, e.context, e.traceHref, e.hasText]),
    [
      ["Backtracked", "After Update task failed", `/project/p1/traces/${"a".repeat(32)}`, true],
      ["Asked again", "Before any tool call", "/project/p1/traces/turns/t2?focus=ev2", false],
    ],
  );
  assert.deepEqual(
    page.examples.map((e) => e.summary),
    [
      "The agent said “Let me try that again”.",
      "The person asked the same thing again in their next message.",
    ],
  );
  assert.equal(
    exampleTraceHref(PROJECT, { turnId: "t3", turnKey: "inferred:x", focusEventId: null }),
    "/project/p1/traces/turns/t3",
  );
});

test("fixes: the worst issues first, each linking to Fixes for its tool, task or topic", () => {
  const issue = (id: string, severity: number, over: object) => ({
    id,
    severity,
    claim: `claim ${id}`,
    fix: `fix ${id}.`,
    pattern: "failed" as const,
    topicId: null,
    subjectKind: "tool",
    subjectKey: "update_task",
    ...over,
  });
  const page = buildSelfCorrectionsPage(
    input({
      reads: reads({
        issues: [
          issue("s1", 0.12, {}),
          issue("s2", 0.3, { subjectKind: "workflow", subjectKey: "wf-a", pattern: "backtrack" }),
          issue("s3", 0.2, {
            subjectKind: "workflow",
            subjectKey: "wf-b",
            pattern: "unanswered",
            topicId: "topic-1",
          }),
        ],
      }),
    }),
  );
  assert.deepEqual(
    page.fixes.map((f) => [f.id, f.reason, f.fixesHref]),
    [
      ["s2", "Backtracks after a tool", "/project/p1/improvement/fixes?task=wf-a"],
      ["s3", "Nothing could answer", "/project/p1/improvement/fixes?task=wf-b&topic=topic-1"],
      ["s1", "Failures before it", "/project/p1/improvement/fixes?tool=update_task"],
    ],
  );
  assert.equal(page.fixes[0]?.issueHref, "/project/p1/health#signal-s2");
  assert.deepEqual(page.fixes[0]?.subject, {
    kind: "task",
    id: "wf-a",
    name: "Update work",
    color: "chart-1",
    href: "/project/p1/health/tasks/wf-a",
  });
  assert.deepEqual(page.fixes[2]?.subject, {
    kind: "tool",
    id: "update_task",
    entryKind: "tool",
    name: "Update task",
    href: "/project/p1/catalogs/tools?q=update_task&highlight=update_task",
  });
  assert.deepEqual(
    page.fixes.map((f) => [f.pattern, f.descriptionTool]),
    [
      ["backtrack", null],
      ["unanswered", null],
      ["failed", null],
    ],
    "a task's backtrack names no tool of its own until the reading names one",
  );
  const same = buildSelfCorrectionsPage(
    input({
      reads: reads({
        issues: [
          issue("tool", 0.3, { fix: "Make X fail clearly." }),
          issue("task", 0.2, {
            subjectKind: "workflow",
            subjectKey: "wf-a",
            fix: "Make X fail clearly.",
          }),
        ],
      }),
    }),
  );
  assert.deepEqual(
    same.fixes.map((f) => f.id),
    ["tool"],
    "a tool and its task with the same fix: shown once, the worse one",
  );
  const tied = buildSelfCorrectionsPage(
    input({
      reads: reads({
        issues: [
          issue("a-task", 0.3, {
            subjectKind: "workflow",
            subjectKey: "wf-a",
            fix: "Make X fail clearly.",
          }),
          issue("z-tool", 0.3, { fix: "Make X fail clearly." }),
        ],
      }),
    }),
  );
  assert.deepEqual(
    tied.fixes.map((f) => f.id),
    ["z-tool"],
    "equally bad: the tool's, whatever the ids, so the link is stable",
  );

  // A backtrack is a description update of the tool it names, never of a skill.
  const rewrites = buildSelfCorrectionsPage(
    input({
      reads: reads({
        issues: [
          issue("t", 0.3, {
            pattern: "backtrack",
            subjectKey: "search_docs",
            fixTool: "search_docs",
            fix: "a",
          }),
          issue("w", 0.2, {
            pattern: "backtrack",
            subjectKind: "workflow",
            subjectKey: "wf-a",
            fixTool: "find_docs",
            fix: "b",
          }),
          issue("s", 0.1, {
            pattern: "backtrack",
            subjectKind: "skill",
            subjectKey: "skill:triage",
            fixTool: "skill:triage",
            fix: "c",
          }),
        ],
      }),
    }),
  );
  assert.deepEqual(
    rewrites.fixes.map((f) => [f.id, f.descriptionTool]),
    [
      ["t", "search_docs"],
      ["w", "find_docs"],
      ["s", null],
    ],
  );
  assert.deepEqual(rewrites.fixes[2]?.subject, {
    kind: "tool",
    id: "triage",
    entryKind: "skill",
    name: "Triage",
    href: "/project/p1/catalogs/skills?skill=triage",
  });
});

test("the trend: per 100 turns bucket by bucket, a day each up to 30 days, a week beyond; a bucket with no turn is a gap", () => {
  assert.deepEqual([trendBucketDays(7), trendBucketDays(30), trendBucketDays(90)], [1, 1, 7]);
  const week = trendOf(7, [
    { bucket: 0, turns: 40, events: 2 },
    { bucket: 3, turns: 30, events: 0 },
    { bucket: 6, turns: 33, events: 4 },
  ]);
  assert.deepEqual(week, {
    values: [5, null, null, 0, null, null, 12.1],
    bucketDays: 1,
    label: "Per 100 turns, day by day",
  });
  assert.equal(
    trendOf(90, [{ bucket: 12, turns: 10, events: 1 }])?.values.length,
    13,
    "thirteen weeks",
  );
  assert.equal(
    trendOf(90, [{ bucket: 12, turns: 10, events: 1 }])?.label,
    "Per 100 turns, week by week",
  );
  assert.equal(trendOf(7, []), null);
  assert.equal(trendOf(7, undefined), null, "not read");
  assert.equal(trendOf(7, [{ bucket: 2, turns: 0, events: 0 }]), null, "no turn anywhere");
  const page = buildSelfCorrectionsPage(
    input({ reads: reads({ buckets: [{ bucket: 6, turns: 100, events: 7 }] }) }),
  );
  assert.deepEqual(page.trend?.values, [null, null, null, null, null, null, 7]);
  assert.equal(buildSelfCorrectionsPage(input()).trend, null);
});

test("filters read in plain words, each with the page without it and the way to the thing itself", () => {
  const page = buildSelfCorrectionsPage(
    input({ windowDays: 30, filters: { tool: "skill:triage", task: "wf-a", topic: "topic-1" } }),
  );
  assert.deepEqual(page.filters, [
    {
      field: "tool",
      label: "After",
      value: "Triage",
      removeHref: "/project/p1/health/self-corrections?days=30&task=wf-a&topic=topic-1",
      href: "/project/p1/catalogs/skills?skill=triage",
    },
    {
      field: "task",
      label: "Task",
      value: "Update work",
      removeHref: "/project/p1/health/self-corrections?days=30&tool=skill%3Atriage&topic=topic-1",
      href: "/project/p1/health/tasks/wf-a",
    },
    {
      field: "topic",
      label: "Intent",
      value: "Release tracking",
      removeHref: "/project/p1/health/self-corrections?days=30&tool=skill%3Atriage&task=wf-a",
      href: "/project/p1/intents?peek=topic-1",
    },
  ]);
  const unnamed = buildSelfCorrectionsPage(input({ filters: { ...NO_FILTERS, topic: "topic-9" } }));
  assert.equal(unnamed.filters[0]?.value, "Unnamed intent", "an intent, never a topic");
});
