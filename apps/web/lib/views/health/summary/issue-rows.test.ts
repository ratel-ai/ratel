import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FixLookup,
  ISSUES_SHOWN,
  issuePeek,
  issueRows,
  issuesLine,
  memberNoun,
  peekedIssue,
  rowOfIssue,
  type TaskLookup,
  taskOfGroup,
  withoutExampleTurns,
} from "@/components/console/health/v2/issue-rows";
import type { SignalView } from "@/lib/readings/trace-signals/view";
import { MOCK_HEALTH_MODEL } from "@/lib/views/health/mock-fixture";
import { signal } from "@/lib/views/health/workflows-view-fixtures";

const PROJECT = "p1";
const TASKS: TaskLookup[] = [
  {
    id: "wf-release",
    name: "Ship a release",
    color: "chart-1",
    tools: ["find_task", "assign_task", "notify"],
    runs: 120,
  },
  { id: "wf-notify", name: "Tell the team", color: null, tools: ["notify", "flaky_api"], runs: 30 },
  {
    id: "wf-wide",
    name: "Everything",
    color: "chart-5",
    tools: ["find_task", "assign_task", "notify", "flaky_api"],
    runs: 300,
  },
];

function sig(
  id: string,
  over: Partial<SignalView> & Pick<SignalView, "kind">,
  chips: readonly string[] = ["flaky_api"],
): SignalView {
  const base = signal(
    id,
    over.kind,
    chips.length === 2 ? "tool_pair" : "tool",
    chips.join("|"),
    chips,
  );
  return { ...base, ...over };
}

test("one row per kind of issue, worst first, every member keeping its link target", () => {
  const rows = issueRows({
    projectId: PROJECT,
    signals: MOCK_HEALTH_MODEL.signals,
    tooEarly: [],
    tasks: [],
    fixes: [],
  });
  const kinds = rows.map((row) => row.kind);
  assert.equal(new Set(kinds).size, kinds.length, "no kind twice");
  assert.equal(rows[0]!.kind, "magnet", "the worst issue leads");
  for (const row of rows) {
    assert.equal(row.anchors.length, row.memberIds.length);
    assert.ok(row.anchors.every((anchor, index) => anchor === `signal-${row.memberIds[index]}`));
    assert.equal(row.peek, issuePeek(row.memberIds[0]!), "the panel opens on the worst member");
  }
  assert.equal(
    issuesLine(rows, MOCK_HEALTH_MODEL.signals),
    `${rows.length} issues across ${new Set(MOCK_HEALTH_MODEL.signals.flatMap((s) => s.subject.chips.map((c) => c.id))).size} tools, worst first.`,
  );
});

test("severity reads as a word: fix now from 0.6, watch below it, too early listed last", () => {
  const rows = issueRows({
    projectId: PROJECT,
    signals: [
      sig("a", { kind: "error_loop", severity: 0.7 }),
      sig("b", { kind: "latency_outlier", severity: 0.3 }),
    ],
    tooEarly: [sig("c", { kind: "empty_result", severity: 0.9 })],
    tasks: [],
    fixes: [],
  });
  assert.deepEqual(
    rows.map((row) => [row.kind, row.tone]),
    [
      ["error_loop", "fix_now"],
      ["latency_outlier", "watch"],
      ["empty_result", "early"],
    ],
  );
  assert.equal(rows[2]!.key, "early:empty_result");
});

test("an issue opens the fix that resolves it; without one, its turns; with no turns, its details", () => {
  const fixes: FixLookup[] = [
    { id: "craft:9", aliases: ["issue:a"], title: "Make flaky_api fail clearly", status: "open" },
    { id: "issue:z", aliases: [], title: "Retire old_report", status: "open" },
  ];
  const withTurns = sig("b", {
    kind: "latency_outlier",
    evidence: { chart: null, turns: [], totalTurns: 12 },
  });
  const rows = issueRows({
    projectId: PROJECT,
    signals: [
      sig("a", { kind: "error_loop", severity: 0.9 }),
      withTurns,
      sig("c", { kind: "empty_result" }),
      sig("z", { kind: "dead_tool" }, []),
    ],
    tooEarly: [],
    tasks: [],
    fixes,
  });
  const by = (kind: string) => rows.find((row) => row.kind === kind)!;
  assert.deepEqual(by("error_loop").action, {
    kind: "fix",
    href: "/project/p1/improvement/fixes?peek=craft%3A9",
  });
  assert.equal(by("error_loop").fixes[0]!.title, "Make flaky_api fail clearly");
  assert.deepEqual(by("latency_outlier").action, { kind: "turns" });
  assert.deepEqual(by("empty_result").action, { kind: "details" });
  assert.deepEqual(
    by("dead_tool").action,
    { kind: "fix", href: "/project/p1/improvement/fixes?peek=issue%3Az" },
    "an issue-made fix is found by its own id",
  );

  // Fixes could not be read: no row claims a fix.
  const unread = issueRows({
    projectId: PROJECT,
    signals: [sig("a", { kind: "error_loop" })],
    tooEarly: [],
    tasks: [],
    fixes: null,
  });
  assert.deepEqual(unread[0]!.fixes, []);
  assert.notEqual(unread[0]!.action.kind, "fix");
});

test("a description update says so and opens Quality › Descriptions: Quality's rewrite of the tool, else the tool", () => {
  const fixes: FixLookup[] = [
    {
      id: "issue:a",
      aliases: [],
      title: "Rewrite flaky_api's searchable description",
      status: "open",
      kind: "rewrite",
      source: "issue",
    },
    {
      id: "rewrite:q1",
      aliases: ["issue:b"],
      title: "Rewrite notify's searchable description",
      status: "open",
      kind: "rewrite",
      source: "rewrite",
      toolIds: ["notify"],
    },
    {
      id: "craft:5",
      aliases: ["issue:c"],
      title: "Make flaky_api fail clearly",
      status: "open",
      kind: "fail-clearly",
      source: "craft",
      toolIds: ["flaky_api"],
    },
    {
      id: "craft:6",
      aliases: ["issue:d"],
      title: "Narrow assign's searchable description",
      status: "open",
      kind: "rewrite",
      source: "craft",
      toolIds: ["assign"],
    },
    {
      id: "rewrite:q2",
      aliases: [],
      title: "Rewrite assign's searchable description",
      status: "applied",
      kind: "rewrite",
      source: "rewrite",
      toolIds: ["assign"],
    },
  ];
  const rows = issueRows({
    projectId: PROJECT,
    signals: [
      sig("a", { kind: "magnet", severity: 0.9 }),
      sig("b", { kind: "first_try_miss", severity: 0.8 }, ["notify"]),
      sig("c", { kind: "error_loop", severity: 0.7 }),
      sig("d", { kind: "buried_tool", severity: 0.6 }, ["assign"]),
    ],
    tooEarly: [],
    tasks: [],
    fixes,
  });
  const by = (kind: string) => rows.find((row) => row.kind === kind)!;
  assert.deepEqual(
    by("magnet").action,
    { kind: "description", href: "/project/p1/quality/descriptions?tool=flaky_api" },
    "an issue's own rewrite: its tool",
  );
  assert.equal(by("magnet").fixes[0]!.description, true);
  assert.deepEqual(
    by("first_try_miss").action,
    { kind: "description", href: "/project/p1/quality/descriptions?peek=rewrite%3Aq1" },
    "Quality's rewrite in its panel",
  );
  assert.deepEqual(
    by("buried_tool").action,
    { kind: "description", href: "/project/p1/quality/descriptions?peek=rewrite%3Aq2" },
    "a drafted rewrite opens the tool's rewrite on Quality",
  );
  assert.deepEqual(
    by("error_loop").action,
    { kind: "fix", href: "/project/p1/improvement/fixes?peek=craft%3A5" },
    "every other fix opens on Fixes",
  );
  assert.equal(by("error_loop").fixes[0]!.description, false);
});

test("a row's task: the one it is raised on, its folded chains' task, else the busiest that runs every tool it names", () => {
  const onTask = issueRows({
    projectId: PROJECT,
    signals: [signal("w", "workflow_failing", "workflow", "wf-notify", ["notify", "flaky_api"])],
    tooEarly: [],
    tasks: TASKS,
    fixes: [],
  });
  assert.deepEqual(onTask[0]!.task, {
    id: "wf-notify",
    name: "Tell the team",
    color: null,
    href: "/project/p1/health/tasks/wf-notify",
  });

  const tool = issueRows({
    projectId: PROJECT,
    signals: [sig("t", { kind: "error_loop" }, ["notify"])],
    tooEarly: [],
    tasks: TASKS,
    fixes: [],
  });
  assert.equal(tool[0]!.task?.id, "wf-wide", "the busiest task that runs notify");
  assert.equal(tool[0]!.task?.color, "chart-5", "with the color it wears on every page");

  const none = issueRows({
    projectId: PROJECT,
    signals: [sig("n", { kind: "error_loop" }, ["lonely_tool"])],
    tooEarly: [],
    tasks: TASKS,
    fixes: [],
  });
  assert.equal(none[0]!.task, null);

  const folded = issueRows({
    projectId: PROJECT,
    signals: [
      sig("c1", { kind: "sequence_chain" }, ["find_task", "assign_task"]),
      sig("c2", { kind: "sequence_chain" }, ["assign_task", "notify"]),
    ],
    tooEarly: [],
    folding: {
      owners: { c1: "wf-release", c2: "wf-release" },
      names: { "wf-release": "Ship a release" },
    },
    tasks: TASKS,
    fixes: [],
  });
  assert.equal(folded.length, 1);
  assert.equal(folded[0]!.title, "2 chains inside Ship a release");
  assert.equal(folded[0]!.task?.id, "wf-release");
  assert.equal(taskOfGroup(folded[0]!.group, []), null, "a task the list does not have is no chip");
});

test("an issue about no tool names its scope in words, not as a tool", () => {
  const rows = issueRows({
    projectId: PROJECT,
    signals: [signal("p", "padding_share", "project", "project", [])],
    tooEarly: [],
    tasks: [],
    fixes: [],
  });
  assert.equal(rows[0]!.scope, "project");
  assert.deepEqual(rows[0]!.tools, { shown: [], more: 0, count: null });
});

test("rows carry no example turns: those are read when an issue is opened", () => {
  const rows = issueRows({
    projectId: PROJECT,
    signals: MOCK_HEALTH_MODEL.signals,
    tooEarly: MOCK_HEALTH_MODEL.tooEarly,
    tasks: [],
    fixes: [],
  });
  assert.ok(
    MOCK_HEALTH_MODEL.signals.some((s) => s.evidence.turns.length > 0),
    "the fixture has some",
  );
  for (const row of rows)
    for (const member of row.group.members) assert.equal(member.evidence.turns.length, 0);
  assert.ok(
    JSON.stringify(rows).indexOf("find the onboarding tasks for Acme") === -1,
    "no captured search in what goes to the browser",
  );
  assert.equal(
    rows[0]!.turns,
    MOCK_HEALTH_MODEL.signals[0]!.evidence.totalTurns,
    "how many there are is still known",
  );
  assert.equal(withoutExampleTurns([]).length, 0);
});

test("a row's tools as chips: two single tools, or the worst pair; the rest counted", () => {
  const singles = issueRows({
    projectId: PROJECT,
    signals: ["a", "b", "c"].map((id, i) =>
      sig(id, { kind: "error_loop", severity: 0.9 - i / 10 }, [`tool_${id}`]),
    ),
    tooEarly: [],
    tasks: [],
    fixes: [],
  });
  assert.deepEqual(singles[0]!.tools, { shown: [["tool_a"], ["tool_b"]], more: 1, count: null });
  const pairs = issueRows({
    projectId: PROJECT,
    signals: [
      sig("p1", { kind: "sequence_chain", severity: 0.9 }, ["find", "assign"]),
      sig("p2", { kind: "sequence_chain", severity: 0.5 }, ["list", "open"]),
    ],
    tooEarly: [],
    tasks: [],
    fixes: [],
  });
  assert.deepEqual(pairs[0]!.tools, { shown: [["find", "assign"]], more: 1, count: null });
});

test("the panel's peek names any member of a row, and nothing else", () => {
  const rows = issueRows({
    projectId: PROJECT,
    signals: [
      sig("a", { kind: "error_loop", severity: 0.9 }),
      sig("b", { kind: "error_loop", severity: 0.4 }, ["notify"]),
    ],
    tooEarly: [],
    tasks: [],
    fixes: [],
  });
  assert.equal(peekedIssue("issue:b"), "b");
  assert.equal(peekedIssue("reading:first_try"), null);
  assert.equal(peekedIssue(null), null);
  assert.equal(rowOfIssue(rows, "b"), rows[0], "the second member opens its row");
  assert.equal(rowOfIssue(rows, "zzz"), null);
  assert.equal(ISSUES_SHOWN, 5);
  assert.equal(memberNoun(rows[0]!.group.members, 2), "tools");
  assert.equal(memberNoun([sig("p", { kind: "sequence_chain" }, ["a", "b"])], 1), "pair");
});
