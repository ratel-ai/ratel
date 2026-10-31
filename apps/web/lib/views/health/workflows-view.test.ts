import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSuggestion,
  chainFolding,
  chainOwners,
  parseStoredWorkflows,
  workflowExamples,
  workflowsView,
} from "@/lib/views/health/workflows-view";
import { signal, storedItem } from "@/lib/views/health/workflows-view-fixtures";

const RELEASE = storedItem(
  "wf-release",
  ["find_pr", "link_pr_to_task", "update_status", "notify"],
  { runs: 60 },
);
const REPORT = storedItem("wf-report", ["get_metrics", "summarize", "post_report"], { runs: 25 });
const STORED = {
  version: 1,
  turnsWithTools: 200,
  multiToolTurns: 120,
  singleStepTurns: 80,
  assignedTurns: 85,
  truncated: false,
  items: [REPORT, RELEASE],
};

test("rows come most runs first, named by their tools unless a label exists", () => {
  const names = new Map([["notify", "Notify the team"]]);
  const view = workflowsView({ stored: STORED, signals: [], names })!;
  assert.deepEqual(
    view.items.map((row) => row.id),
    ["wf-release", "wf-report"],
  );
  const [release] = view.items;
  assert.equal(release!.name, "find_pr > link_pr_to_task > update_status > Notify the team");
  assert.equal(release!.description, null);
  assert.deepEqual(release!.focusTools, ["find_pr", "link_pr_to_task", "update_status", "notify"]);
  assert.equal(release!.steps[3]!.label, "Notify the team");
  assert.equal(release!.completion, 0.7);
  assert.equal(release!.medianMs, 4_200);
  assert.deepEqual(release!.failingStep, {
    tool: { id: "link_pr_to_task", label: "link_pr_to_task" },
    share: 0.75,
  });
  assert.equal(view.multiToolTurns, 120);
  assert.equal(view.minRuns, 10);
  assert.equal(view.minTools, 2);

  const labels = new Map([
    [
      "wf-release",
      { name: "Close out a release", description: "Ships a release and tells the team." },
    ],
  ]);
  const named = workflowsView({ stored: STORED, signals: [], names, labels })!;
  assert.equal(named.items[0]!.name, "Close out a release");
  assert.equal(named.items[0]!.description, "Ships a release and tells the team.");
});

test("a row leads with its failing problem before a slow one, and says what to build for a fixed chain", () => {
  const signals = [
    signal("s-slow", "workflow_slow", "workflow", "wf-release"),
    signal("s-fail", "workflow_failing", "workflow", "wf-release"),
    signal("s-fixed", "workflow_fixed_chain", "workflow", "wf-report"),
    signal("s-other", "workflow_failing", "workflow", "wf-elsewhere"),
  ];
  const view = workflowsView({ stored: STORED, signals, names: new Map() })!;
  const [release, report] = view.items;
  assert.deepEqual(release!.problem, {
    signalId: "s-fail",
    kind: "workflow_failing",
    claim: "claim of s-fail",
  });
  assert.equal(release!.build, null);
  assert.equal(report!.problem, null);
  assert.equal(report!.build, buildSuggestion(3));
  assert.match(report!.build!, /one tool for these 3 steps, or a skill that runs them in order/);
});

test("examples are failed runs first, then the slowest, then the newest, each run once", () => {
  const examples = workflowExamples(RELEASE);
  assert.deepEqual(examples, [
    { turnId: "t-f1", focusEventId: "e-f1", why: "failed" },
    { turnId: "t-f2", focusEventId: null, why: "failed" },
    { turnId: "t-s1", focusEventId: "e-s1", why: "slow" },
    { turnId: "t-r1", focusEventId: null, why: "recent" },
  ]);
  assert.equal(workflowExamples(RELEASE, 2).length, 2);
});

test("chains inside a workflow's core belong to it, the busiest one when several hold the pair", () => {
  const signals = [
    signal("c1", "sequence_chain", "tool_pair", "find_pr>link_pr_to_task", [
      "find_pr",
      "link_pr_to_task",
    ]),
    signal("c2", "sequence_chain", "tool_pair", "update_status>notify", [
      "update_status",
      "notify",
    ]),
    signal("c3", "sequence_chain", "tool_pair", "find_pr>summarize", ["find_pr", "summarize"]),
    signal("e1", "error_loop", "tool", "notify", ["notify"]),
  ];
  const busier = storedItem("wf-wide", ["find_pr", "link_pr_to_task"], { runs: 99 });
  assert.deepEqual(chainOwners([RELEASE, REPORT, busier], signals), {
    c1: "wf-wide",
    c2: "wf-release",
  });
  assert.deepEqual(chainOwners([RELEASE, REPORT], signals), { c1: "wf-release", c2: "wf-release" });
});

test("the folding names each workflow, and is absent when nothing folds", () => {
  const signals = [
    signal("c1", "sequence_chain", "tool_pair", "find_pr>notify", ["find_pr", "notify"]),
  ];
  const view = workflowsView({ stored: STORED, signals, names: new Map() })!;
  assert.deepEqual(chainFolding(view), {
    owners: { c1: "wf-release" },
    names: {
      "wf-release": "find_pr > link_pr_to_task > update_status > notify",
      "wf-report": "get_metrics > summarize > post_report",
    },
  });
  assert.equal(
    chainFolding(workflowsView({ stored: STORED, signals: [], names: new Map() })),
    undefined,
  );
  assert.equal(chainFolding(null), undefined);
});

test("no stored workflows means no section; an empty list is an empty section", () => {
  assert.equal(workflowsView({ stored: undefined, signals: [], names: new Map() }), null);
  assert.equal(workflowsView({ stored: { items: "nope" }, signals: [], names: new Map() }), null);
  const empty = workflowsView({ stored: { ...STORED, items: [] }, signals: [], names: new Map() })!;
  assert.deepEqual(empty.items, []);
});

test("malformed stored items are skipped, not drawn", () => {
  const parsed = parseStoredWorkflows({
    ...STORED,
    items: [RELEASE, { id: 3 }, { id: "x", typicalOrder: [] }, null],
  });
  assert.deepEqual(
    parsed?.items.map((item) => item.id),
    ["wf-release"],
  );
});

test("the Summary's finish rate is the task pages': runs that asked for a task and called no tool count as unfinished", () => {
  const insights = {
    version: 3 as const,
    asksSeen: 50,
    judged: 50,
    unclear: 0,
    placed: { "wf-release": { turns: 60, outside: 10, outsideWithErrors: 4 } },
    unserved: [],
  };
  const view = workflowsView({ stored: STORED, signals: [], names: new Map(), insights })!;
  const release = view.items.find((row) => row.id === "wf-release")!;
  assert.equal(
    release.completion,
    28 / 46,
    "28 finished of the 40 runs placed and the 6 that called no tool",
  );
  assert.deepEqual(release.stoppedShort, { runs: 10, withErrors: 4 }, "still said under the row");
});
