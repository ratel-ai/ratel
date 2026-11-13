import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillFull } from "@/lib/catalog/agent-tools/outputs";
import {
  type BulkTarget,
  bulkFailureLabel,
  planBulk,
  pruneSelection,
  runBulkAction,
  selectAllState,
  selectionKey,
  summarizeBulk,
  toggleAll,
  toggleOne,
} from "@/lib/console/explore/bulk";

function skill(over: Partial<SkillFull> = {}): SkillFull {
  return {
    id: "id-1",
    name: "refunds",
    description: "Refund a customer order.",
    searchableDescription: null,
    tags: ["billing"],
    tools: ["payments"],
    status: "published",
    version: 1,
    endUserId: null,
    model: "claude-sonnet-5",
    updatedAt: "2026-06-01T00:00:00.000Z",
    publishedAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-05-01T00:00:00.000Z",
    metadata: {},
    body: "## Steps",
    ...over,
  };
}

/* — selection toggles ——————————————————————————————————————————————————————— */

test("toggleOne adds an unselected id and removes a selected one, without mutating", () => {
  const start: ReadonlySet<string> = new Set(["a"]);
  assert.deepEqual([...toggleOne(start, "b")].sort(), ["a", "b"]);
  assert.deepEqual([...toggleOne(start, "a")], []);
  assert.deepEqual([...start], ["a"], "input set is never mutated");
});

test("toggleAll selects the union when any visible row is unselected", () => {
  const next = toggleAll(new Set(["a", "hidden"]), ["a", "b", "c"]);
  assert.deepEqual([...next].sort(), ["a", "b", "c", "hidden"]);
});

test("toggleAll deselects only the visible rows when all of them are selected", () => {
  const next = toggleAll(new Set(["a", "b", "hidden"]), ["a", "b"]);
  assert.deepEqual([...next], ["hidden"], "rows hidden by the filter keep their selection");
});

test("toggleAll over an empty visible set is a no-op", () => {
  assert.deepEqual([...toggleAll(new Set(["a"]), [])], ["a"]);
});

test("selectAllState reports none/some/all over the visible rows", () => {
  assert.equal(selectAllState(new Set(), ["a", "b"]), "none");
  assert.equal(selectAllState(new Set(["a"]), ["a", "b"]), "some");
  assert.equal(selectAllState(new Set(["a", "b", "hidden"]), ["a", "b"]), "all");
  assert.equal(
    selectAllState(new Set(["hidden"]), ["a", "b"]),
    "none",
    "hidden selections don't count",
  );
  assert.equal(selectAllState(new Set(["a"]), []), "none", "no visible rows is never 'all'");
});

test("pruneSelection drops ids that no longer exist in the refreshed skills", () => {
  const skills = [skill({ id: "a" }), skill({ id: "b" })];
  assert.deepEqual([...pruneSelection(new Set(["a", "gone"]), skills)], ["a"]);
});

test("selectionKey is order-independent and distinguishes different sets", () => {
  assert.equal(selectionKey(new Set(["b", "a"])), selectionKey(new Set(["a", "b"])));
  assert.notEqual(selectionKey(new Set(["a"])), selectionKey(new Set(["a", "b"])));
  assert.equal(selectionKey(new Set()), "");
});

/* — planning ————————————————————————————————————————————————————————————————— */

test("planBulk publish targets only non-published selections, resolving version and name now", () => {
  const skills = [
    skill({ id: "a", name: "alpha", status: "draft", version: 3 }),
    skill({ id: "b", name: "beta", status: "published", version: 1 }),
    skill({ id: "c", name: "gamma", status: "archived", version: 7 }),
    skill({ id: "d", name: "delta", status: "draft", version: 2 }),
  ];
  const plan = planBulk(skills, new Set(["a", "b", "c", "gone"]), "publish");
  assert.deepEqual(plan.targets, [
    { id: "a", name: "alpha", version: 3 },
    { id: "c", name: "gamma", version: 7 },
  ]);
  assert.equal(
    plan.skipped,
    1,
    "already-published selections are skipped, unknown ids are dropped",
  );
});

test("planBulk archive skips already-archived selections", () => {
  const skills = [
    skill({ id: "a", status: "archived", version: 2 }),
    skill({ id: "b", name: "beta", status: "published", version: 5 }),
  ];
  const plan = planBulk(skills, new Set(["a", "b"]), "archive");
  assert.deepEqual(plan.targets, [{ id: "b", name: "beta", version: 5 }]);
  assert.equal(plan.skipped, 1);
});

/* — the sequential runner ———————————————————————————————————————————————————— */

test("runBulkAction runs targets strictly in order and aggregates the outcome", async () => {
  const targets: BulkTarget[] = [
    { id: "a", name: "alpha", version: 1 },
    { id: "b", name: "beta", version: 2 },
    { id: "c", name: "gamma", version: 3 },
  ];
  const calls: string[] = [];
  const progress: number[] = [];
  const out = await runBulkAction(
    targets,
    async (t) => {
      calls.push(t.id);
      if (t.id === "b") return { ok: false as const, status: 409, reason: "version_conflict" };
      return { ok: true as const, data: {} };
    },
    (done) => progress.push(done),
  );
  assert.deepEqual(calls, ["a", "b", "c"], "sequential, never parallel");
  assert.deepEqual(progress, [1, 2, 3]);
  assert.equal(out.succeeded, 2);
  assert.deepEqual(out.failures, [
    { id: "b", name: "beta", status: 409, reason: "version_conflict" },
  ]);
});

test("runBulkAction over no targets resolves to an empty outcome", async () => {
  const out = await runBulkAction([], async () => ({ ok: true as const, data: {} }));
  assert.deepEqual(out, { succeeded: 0, failures: [] });
});

/* — summaries ———————————————————————————————————————————————————————————————— */

test("summarizeBulk covers clean, mixed, and nothing-to-do runs", () => {
  assert.equal(
    summarizeBulk({ action: "publish", succeeded: 3, failures: [], skipped: 0 }),
    "Published 3 of 3 skills.",
  );
  assert.equal(
    summarizeBulk({ action: "archive", succeeded: 1, failures: [], skipped: 0 }),
    "Archived 1 of 1 skill.",
  );
  assert.equal(
    summarizeBulk({
      action: "publish",
      succeeded: 2,
      failures: [{ id: "b", name: "beta", status: 409, reason: "version_conflict" }],
      skipped: 2,
    }),
    "Published 2 of 3 skills · 1 failed · 2 already published.",
  );
  assert.equal(
    summarizeBulk({ action: "archive", succeeded: 0, failures: [], skipped: 2 }),
    "Nothing to archive — 2 already archived.",
  );
  assert.equal(
    summarizeBulk({ action: "archive", succeeded: 0, failures: [], skipped: 0 }),
    "Nothing to archive.",
    "an empty plan (e.g. retrying rows that vanished) isn't 'already archived'",
  );
});

test("bulkFailureLabel maps the route failure onto a short per-row clause", () => {
  assert.equal(
    bulkFailureLabel(409, "version_conflict"),
    "changed since you selected it — retry uses the latest version",
  );
  assert.equal(bulkFailureLabel(404, "not_found"), "no longer exists");
  assert.equal(
    bulkFailureLabel(404, undefined),
    "no longer exists",
    "the route's actual 404 body carries no reason field",
  );
  assert.equal(bulkFailureLabel(401), "session expired — sign in again");
  assert.equal(bulkFailureLabel(0), "network error");
  assert.equal(bulkFailureLabel(500), "failed unexpectedly");
});
