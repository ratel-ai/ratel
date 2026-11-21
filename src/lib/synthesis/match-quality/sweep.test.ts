import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dueProjectsInRotation,
  MATCH_QUALITY_RUN_INTERVAL_MS,
  MAX_PROJECTS_SCANNED_PER_SWEEP,
  type SweepCandidate,
  selectProjectsForSweep,
} from "@/lib/readings/match-quality/sweep";

const NOW = new Date("2026-09-14T12:00:00Z");
const WEEK_AGO = new Date(NOW.getTime() - MATCH_QUALITY_RUN_INTERVAL_MS - 1000);
const YESTERDAY = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

function candidate(projectId: string, comparisonCount = 100): SweepCandidate {
  return {
    projectId,
    organizationId: `org-${projectId}`,
    projectName: projectId,
    experimentName: "mcp_search_operations",
    comparisonCount,
  };
}

const ALLOW = () => true;

test("a project never run before is due", () => {
  const picked = selectProjectsForSweep([candidate("a")], {
    isEligible: ALLOW,
    lastRunAt: new Map(),
    now: NOW,
  });
  assert.deepEqual(
    picked.map((p) => p.projectId),
    ["a"],
  );
  assert.equal(picked[0].trigger, "scheduled");
});

test("a project run inside the interval is not due again", () => {
  const picked = selectProjectsForSweep([candidate("a")], {
    isEligible: ALLOW,
    lastRunAt: new Map([["a", YESTERDAY]]),
    now: NOW,
  });
  assert.deepEqual(picked, []);
});

test("a project run longer ago than the interval is due", () => {
  const picked = selectProjectsForSweep([candidate("a")], {
    isEligible: ALLOW,
    lastRunAt: new Map([["a", WEEK_AGO]]),
    now: NOW,
  });
  assert.equal(picked.length, 1);
});

test("a project with no comparisons is skipped rather than enqueued to decline", () => {
  const picked = selectProjectsForSweep([candidate("a", 0)], {
    isEligible: ALLOW,
    lastRunAt: new Map(),
    now: NOW,
  });
  assert.deepEqual(picked, []);
});

test("an ineligible plan is skipped", () => {
  const picked = selectProjectsForSweep([candidate("a"), candidate("b")], {
    isEligible: (c) => c.projectId === "b",
    lastRunAt: new Map(),
    now: NOW,
  });
  assert.deepEqual(
    picked.map((p) => p.projectId),
    ["b"],
  );
});

test("the cap is spent as a rotation, so no project is starved", () => {
  const lastRunAt = new Map([
    ["busy", new Date(NOW.getTime() - 8 * 24 * 3_600_000)],
    ["stale", new Date(NOW.getTime() - 40 * 24 * 3_600_000)],
  ]);
  const picked = selectProjectsForSweep(
    [candidate("busy"), candidate("stale"), candidate("never")],
    { isEligible: ALLOW, lastRunAt, now: NOW, cap: 2 },
  );
  // Never-run first, then the one waiting longest. "busy" waits for next pass.
  assert.deepEqual(
    picked.map((p) => p.projectId),
    ["never", "stale"],
  );
});

test("ordering is stable when two projects have never run", () => {
  const picked = selectProjectsForSweep([candidate("b"), candidate("a")], {
    isEligible: ALLOW,
    lastRunAt: new Map(),
    now: NOW,
  });
  assert.deepEqual(
    picked.map((p) => p.projectId),
    ["a", "b"],
  );
});

/* — Rotation and the scan cap ------------------------------------------------ */

test("only due projects are scanned", () => {
  const due = dueProjectsInRotation(["fresh", "stale"], new Map([["fresh", YESTERDAY]]), NOW);
  assert.deepEqual(due, ["stale"]);
});

test("the scan is capped, and the cap is spent least-recently-run first", () => {
  const ids = Array.from({ length: 50 }, (_unused, index) => `p${String(index).padStart(2, "0")}`);
  // p00 ran longest ago, p49 most recently; all are past the interval.
  const lastRunAt = new Map(
    ids.map((id, index) => [id, new Date(NOW.getTime() - (50 - index) * 8 * 24 * 3_600_000)]),
  );
  const due = dueProjectsInRotation(ids, lastRunAt, NOW);
  assert.equal(due.length, MAX_PROJECTS_SCANNED_PER_SWEEP);
  assert.equal(due[0], "p00");
  assert.equal(due.at(-1), `p${String(MAX_PROJECTS_SCANNED_PER_SWEEP - 1).padStart(2, "0")}`);
});

test("a project the cap skipped this pass sorts first on the next one", () => {
  const ids = Array.from({ length: 30 }, (_unused, index) => `p${String(index).padStart(2, "0")}`);
  const lastRunAt = new Map<string, Date>();
  const first = dueProjectsInRotation(ids, lastRunAt, NOW, { cap: 5 });
  assert.deepEqual(first, ["p00", "p01", "p02", "p03", "p04"]);

  // Those five ran; the rest have still never run, so they sort ahead of them.
  for (const id of first) lastRunAt.set(id, NOW);
  const later = new Date(NOW.getTime() + 8 * 24 * 3_600_000);
  const second = dueProjectsInRotation(ids, lastRunAt, later, { cap: 5 });
  assert.deepEqual(second, ["p05", "p06", "p07", "p08", "p09"]);
});

test("never-run projects sort ahead of every project that has run", () => {
  const lastRunAt = new Map([["ran", new Date(NOW.getTime() - 365 * 24 * 3_600_000)]]);
  assert.deepEqual(dueProjectsInRotation(["ran", "never"], lastRunAt, NOW), ["never", "ran"]);
});

test("a zero interval makes everything due, which is what force does", () => {
  const lastRunAt = new Map([["fresh", YESTERDAY]]);
  assert.deepEqual(dueProjectsInRotation(["fresh"], lastRunAt, NOW, { intervalMs: 0 }), ["fresh"]);
});
