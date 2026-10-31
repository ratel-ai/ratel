import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNAL_KINDS } from "@/lib/readings/trace-signals/view";
import type { SignalRecord } from "@/lib/views/health/signals/claims-model";
import {
  foldIssues,
  ISSUE_FAMILIES,
  type IssueView,
  issueAction,
  issueFamily,
  issueView,
} from "@/lib/views/tasks/issues";

const P = "11111111-1111-4111-8111-111111111111";

function record(over: Partial<SignalRecord>): SignalRecord {
  return {
    id: "sig-1",
    kind: "first_try_miss",
    status: "open",
    tier: "deterministic",
    subjectKind: "tool",
    subjectKey: "lookup",
    subjectIds: ["lookup"],
    entryKind: "tool",
    severity: 0.3,
    impact: 12,
    n: 30,
    metrics: { share: 0.4, k: 12, n: 30, route: "rewrite_description" },
    turnIds: [],
    traceEventIds: [],
    totalTurns: 12,
    turnSourceMix: { declared: 0, inferred: 0, otlp: 30 },
    firstSeenAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: "2026-10-02T00:00:00.000Z",
    ...over,
  };
}

const ctx = { projectId: P, taskId: "wf-1", fixes: null };

test("every issue kind has a family mark; an unknown kind reads as an issue", () => {
  for (const kind of SIGNAL_KINDS) assert.ok(ISSUE_FAMILIES.includes(issueFamily(kind)), kind);
  assert.equal(issueFamily("workflow_failing"), "failing");
  assert.equal(issueFamily("self_correcting"), "correcting");
  assert.equal(issueFamily("brand_new_kind"), "other");
});

test("a description fix says so and goes to Quality › Descriptions, on the tool", () => {
  const action = issueAction(
    { record: record({}), proposalId: null },
    "Rewrite lookup's searchable description.",
    ctx,
  );
  assert.deepEqual(action, {
    kind: "description",
    label: "Update description",
    href: `/project/${P}/quality/descriptions?tool=lookup`,
  });
});

test("without Fixes: a linked draft opens, a change with no draft lists the task's fixes, and an issue with no change has no button", () => {
  const chain = record({
    id: "sig-2",
    kind: "workflow_fixed_chain",
    subjectKind: "workflow",
    subjectKey: "wf-1",
    subjectIds: ["a", "b"],
    metrics: {},
  });
  assert.deepEqual(
    issueAction({ record: chain, proposalId: "c-7" }, "Combine these steps into one tool.", ctx),
    {
      kind: "fix",
      label: "Fix",
      href: `/project/${P}/improvement/fixes?peek=c-7`,
    },
  );
  assert.deepEqual(
    issueAction({ record: chain, proposalId: null }, "Combine these steps into one tool.", ctx),
    {
      kind: "fix",
      label: "Fix",
      href: `/project/${P}/improvement/fixes?task=wf-1`,
    },
  );
  const slow = record({
    id: "sig-3",
    kind: "latency_outlier",
    metrics: { p95Ms: 30_000, calls: 40 },
  });
  assert.equal(
    issueAction({ record: slow, proposalId: null }, "Nothing to change in the catalog.", ctx),
    null,
  );
});

test("an issue as its row reads it: family, title, one number with its caption, the tools it names; sentences kept for the panel", () => {
  const view = issueView(
    { record: record({}), proposalId: null },
    { ...ctx, names: new Map([["lookup", "Look up order"]]), labels: new Map(), windowDays: 30 },
  );
  assert.equal(view.family, "search");
  assert.equal(view.title, "Needs a second search");
  assert.deepEqual(view.figure, { display: "40%", caption: "searched twice" });
  assert.deepEqual(view.tools, [{ id: "lookup", label: "Look up order" }]);
  assert.equal(view.onTask, false);
  assert.match(view.claim, /Look up order/);
  assert.ok(view.fix.length > 0);
  assert.equal(view.action?.kind, "description");
});

test("one row per kind: the task's own issue keeps the row, the same kind on its tools folds in, and a link to a folded one still finds it", () => {
  const row = (over: Partial<IssueView>): IssueView => ({
    id: "sig-1",
    kind: "self_correcting",
    family: "correcting",
    title: "Agent keeps correcting itself",
    figure: { display: "12", caption: "per 100 runs" },
    claim: "",
    fix: "",
    tools: [],
    onTask: true,
    action: null,
    aliases: [],
    ...over,
  });
  const onTask = row({});
  const onLookup = row({
    id: "sig-2",
    onTask: false,
    tools: [{ id: "lookup", label: "lookup" }],
    action: { kind: "description", label: "Update description", href: "/d" },
  });
  const onSearch = row({
    id: "sig-3",
    onTask: false,
    tools: [
      { id: "search", label: "search" },
      { id: "lookup", label: "lookup" },
    ],
  });
  const slow = row({ id: "sig-4", kind: "workflow_slow", family: "slow" });

  const folded = foldIssues([onTask, slow, onLookup, onSearch]);
  assert.deepEqual(
    folded.map((issue) => issue.id),
    ["sig-1", "sig-4"],
    "order kept, one row per kind",
  );
  const kept = folded[0]!;
  assert.equal(kept.onTask, true);
  assert.deepEqual(
    kept.tools.map((tool) => tool.id),
    ["lookup", "search"],
    "tools named once each",
  );
  assert.deepEqual(kept.aliases, ["sig-2", "sig-3"]);
  assert.deepEqual(
    kept.action,
    onLookup.action,
    "a folded row's action stands in when the kept row has none",
  );
  assert.deepEqual(onTask.tools, [], "inputs untouched");
  assert.deepEqual(foldIssues([slow]), [slow]);
});
