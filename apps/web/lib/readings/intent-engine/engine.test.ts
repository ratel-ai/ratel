import assert from "node:assert/strict";
import { test } from "node:test";
import { type EngineEventRow, foldAsks, MEMBER_CAP } from "@/lib/readings/intent-engine/engine";
import type { EngineState } from "@/lib/readings/intent-types/engine-types";

let seq = 0;
const T0 = Date.parse("2026-10-01T00:00:00Z");

function row(partial: Partial<EngineEventRow> & Pick<EngineEventRow, "type">): EngineEventRow {
  seq += 1;
  return {
    id: `e${seq}`,
    lane: "runtime",
    sessionId: "s1",
    turnId: `t${seq}`,
    sourceId: "src",
    query: null,
    toolId: null,
    skillId: null,
    receivedAt: new Date(T0 + seq * 1000),
    ...partial,
  };
}

/** A search and the call that confirmed it, in one turn. */
function turn(query: string, toolId?: string, turnId = `turn-${seq + 1}`): EngineEventRow[] {
  const out = [row({ type: "search", query, turnId })];
  if (toolId) out.push(row({ type: "invoke_start", toolId, turnId }));
  return out;
}

const empty = (): EngineState => ({ clusters: [], nextGraphN: 0 });

function fold(rows: EngineEventRow[], state: EngineState = empty()) {
  return foldAsks({ state, rows, hits: new Map(), now: T0 + 10_000_000 });
}

test("a confirmed search learns like the SDK: support, member, edge", () => {
  const out = fold(turn("list open invoices for acme", "list_invoices"));
  assert.equal(out.state.clusters.length, 1);
  const [c] = out.state.clusters;
  assert.equal(c.support, 1);
  assert.deepEqual(c.tools, { list_invoices: 1 });
  assert.deepEqual(c.servedMembers, ["list open invoices for acme"]);
  assert.equal(c.sources.src.support, 1);
  assert.equal(out.assignments.length, 1);
  assert.equal(out.stats.confirmed, 1);
});

test("an ask nothing answered still gets a cluster, with no served edges", () => {
  const out = fold(turn("cancel my subscription right away"));
  const [c] = out.state.clusters;
  assert.equal(c.support, 0);
  assert.deepEqual(c.tools, {});
  assert.deepEqual(c.servedMembers, []);
  assert.equal(c.asks, 1);
  assert.equal(out.assignments[0].clusterUuid, c.uuid);
});

test("restatements join one cluster; different requests stay apart", () => {
  const out = fold([
    ...turn("check the CI tests on main", "ci_status"),
    ...turn("check CI tests for main branch", "ci_status"),
    ...turn("create a task for the release", "create_task"),
  ]);
  assert.equal(out.state.clusters.length, 2);
  const ci = out.state.clusters.find((c) => c.tools.ci_status)!;
  assert.equal(ci.support, 2);
  assert.equal(ci.members.length, 2);
});

test("weak wording joins when the tools agree, never on tools alone", () => {
  const first = fold([
    ...turn("refund the customer order", "issue_refund"),
    ...turn("summarize yesterday standup notes", "read_notes"),
  ]);
  const joined = fold(turn("customer wants money back for order", "issue_refund"), first.state);
  const refund = joined.state.clusters.find((c) => c.tools.issue_refund)!;
  assert.equal(refund.support, 2, "shares 'customer order' and the refund tool");
  const apart = fold(turn("send the weekly digest email", "issue_refund"), first.state);
  assert.equal(apart.state.clusters.length, 3, "same tool, no shared wording: a new cluster");
});

test("an ask holding two known requests counts toward both", () => {
  const seeded = fold([
    ...turn("check the CI tests", "ci_status"),
    ...turn("fix the CI tests", "ci_fix"),
  ]);
  const out = fold(
    [
      row({ type: "search", query: "check the CI tests and fix the failed ones", turnId: "x" }),
      row({ type: "invoke_start", toolId: "ci_status", turnId: "x" }),
      row({ type: "invoke_start", toolId: "ci_fix", turnId: "x" }),
    ],
    seeded.state,
  );
  assert.equal(out.state.clusters.length, 2, "no third cluster");
  assert.equal(out.assignments.length, 2);
  assert.deepEqual(new Set(out.assignments.map((a) => a.askIndex)), new Set([0, 1]));
  assert.deepEqual(
    out.assignments.map((a) => a.text),
    ["check the CI tests", "fix the failed CI tests"],
    "the carried object loses its article",
  );
  const check = out.state.clusters.find((c) => c.tools.ci_status)!;
  const fix = out.state.clusters.find((c) => c.tools.ci_fix)!;
  assert.equal(check.tools.ci_status, 2);
  assert.equal(fix.tools.ci_fix, 2);
  assert.equal(check.tools.ci_fix, undefined, "each call goes to the request it serves");
});

test("a user's message is clustered and credited as evidence only", () => {
  const out = fold([
    row({ type: "turn_start", query: "please reconcile last month's payouts", turnId: "u1" }),
    row({ type: "invoke_start", toolId: "reconcile_payouts", turnId: "u1" }),
  ]);
  const [c] = out.state.clusters;
  assert.equal(out.assignments[0].kind, "user_message");
  assert.equal(c.support, 0, "not a served observation");
  assert.deepEqual(c.usage, { "tool:reconcile_payouts": 1 });
});

test("an OTLP trace learns its ask once per change", () => {
  const rows: EngineEventRow[] = [
    row({
      type: "search",
      lane: "otlp",
      query: "draft the quarterly report",
      sessionId: "tr",
      turnId: "tr",
    }),
    row({
      type: "search",
      lane: "otlp",
      query: "draft the quarterly report",
      sessionId: "tr",
      turnId: "tr",
    }),
    row({ type: "invoke_start", lane: "otlp", toolId: "write_doc", sessionId: "tr", turnId: "tr" }),
  ];
  const out = fold(rows);
  assert.equal(out.stats.repeated, 1);
  assert.equal(out.assignments.length, 1);
  assert.equal(out.assignments[0].kind, "prompt");
});

test("members are capped, newest kept", () => {
  const rows: EngineEventRow[] = [];
  for (let i = 0; i < MEMBER_CAP + 5; i += 1)
    rows.push(
      ...turn(
        `deploy service alpha to staging cluster number ${"x".repeat(i % 7)} v${i}`,
        "deploy",
      ),
    );
  const out = fold(rows);
  const big = out.state.clusters.reduce((a, b) => (a.members.length >= b.members.length ? a : b));
  assert.ok(big.members.length <= MEMBER_CAP);
});

test("an ask holding several actions counts where it joins but never widens that cluster", () => {
  const seeded = fold([
    ...turn("create task in project", "create_task"),
    ...turn("create a task in the project", "create_task"),
  ]);
  const out = fold(
    turn("create task in project list tasks in project", "create_task"),
    seeded.state,
  );
  const create = out.state.clusters.find((c) => c.members.includes("create task in project"))!;
  const ask = out.assignments.find((a) => a.text.startsWith("create task in project list"))!;
  assert.equal(ask.clusterUuid, create.uuid, "it counts toward the cluster it joined");
  assert.ok(
    !create.members.includes("create task in project list tasks in project"),
    "but is not a member there",
  );
  assert.ok(
    create.servedMembers.includes("create task in project list tasks in project"),
    "a runtime is still served the search it was",
  );
  assert.equal(create.tools.create_task, 3, "and its confirmed call still counts");
  assert.equal(out.stats.multiAction, 1);
  // So a later "list tasks" ask has no bridge into the create cluster.
  const later = fold(turn("list tasks in project", "list_tasks"), out.state);
  const listed = later.assignments.at(-1)!;
  assert.notEqual(listed.clusterUuid, create.uuid);
});

/* intent frames */

const CATALOG = ["create_task", "add_task_comment", "list_tasks"];

function foldFrames(rows: EngineEventRow[], state: EngineState = empty()) {
  return foldAsks({
    state,
    rows,
    hits: new Map(),
    catalogIds: CATALOG,
    frames: true,
    now: T0 + 10_000_000,
  });
}

test("with frames, a first-time three-action ask is placed once per action", () => {
  const ask = "create task comment on task list tasks in project";
  const rows = turn(ask, "create_task");
  const out = foldFrames(rows);
  assert.equal(out.state.clusters.length, 3, "one cluster per action, none pre-existing");
  assert.deepEqual(
    out.assignments.map((a) => [a.askIndex, a.text]),
    [
      [0, "create task"],
      [1, "comment on task"],
      [2, "list tasks in project"],
    ],
  );
  assert.equal(new Set(out.assignments.map((a) => a.clusterUuid)).size, 3);
  for (const c of out.state.clusters)
    assert.ok(!c.members.includes(ask), "the raw ask is never a member");

  // The served layer is the learner's: the raw search, once, with the call it led to.
  const served = out.state.clusters.filter((c) => c.support > 0);
  assert.equal(served.length, 1);
  assert.deepEqual(served[0].servedMembers, [ask]);
  assert.deepEqual(served[0].tools, { create_task: 1 });
  assert.equal(
    served[0].members[0],
    "create task",
    "credited to the frame whose action names the tool",
  );
  assert.equal(out.stats.confirmed, 1);
  const servedTexts = out.state.clusters.flatMap((c) => c.servedMembers);
  assert.equal(servedTexts.filter((m) => m === ask).length, 1, "the raw search is served once");
});

test("with frames, a later single-action ask joins its frame's cluster", () => {
  const first = foldFrames(
    turn("create task comment on task list tasks in project", "create_task"),
  );
  const out = foldFrames(turn("list tasks in project", "list_tasks"), first.state);
  const listing = out.state.clusters.find((c) => c.members.includes("list tasks in project"))!;
  assert.equal(listing.asks, 2);
  assert.equal(out.state.clusters.length, 3, "nothing new");
  assert.equal(out.assignments[0].clusterUuid, listing.uuid);
});

test("with frames, an ask whose verbs are one action is not split", () => {
  const out = foldFrames(turn("Add a progress comment to an existing task", "add_task_comment"));
  assert.equal(out.assignments.length, 1);
  assert.equal(out.stats.split, 0);
  assert.deepEqual(out.state.clusters[0].members, ["Add a progress comment to an existing task"]);
});

test("with frames, two frames that say the same thing in one ask share one cluster", () => {
  const out = foldFrames(
    turn("create task for billing and then create task for billing", "create_task"),
  );
  assert.equal(
    out.state.clusters.length,
    1,
    "the second frame finds the cluster the first just made",
  );
  assert.equal(out.assignments.length, 1, "frames landing in one cluster count there once");
  assert.equal(out.stats.created, 1);
  assert.deepEqual(out.state.clusters[0].members, ["create task for billing"]);
});

test("frames off folds as before", () => {
  const rows = turn("create task comment on task list tasks in project", "create_task");
  const out = foldAsks({
    state: empty(),
    rows,
    hits: new Map(),
    catalogIds: CATALOG,
    now: T0 + 10_000_000,
  });
  assert.equal(out.assignments.length, 1);
  assert.equal(out.state.clusters.length, 1);
});
