import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseRunBasis,
  countRun,
  emptyRunBasisCounts,
  MIN_EXACT_RUNS,
  MIN_INFERRED_FOR_MIX,
  minesRun,
  type RunBasisCounts,
  runsLookMixed,
} from "@/lib/readings/trace-signals/workflows/run-basis";

const AT = new Date("2026-09-20T10:00:00Z");

function counted(
  runs: {
    source: "declared" | "inferred" | "otlp";
    endedBy?: "gap" | "cap" | "idle";
    tools: number;
    at?: Date;
  }[],
): RunBasisCounts {
  const counts = emptyRunBasisCounts();
  for (const run of runs)
    countRun(
      counts,
      { turnSource: run.source, endedBy: run.endedBy ?? "gap", startedAt: run.at ?? AT },
      run.tools,
    );
  return counts;
}

const times = <T>(n: number, make: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => make(i));

test("a single-user agent without turn ids keeps every guessed run: quiet gaps end them", () => {
  const basis = chooseRunBasis(
    counted(times(60, () => ({ source: "inferred" as const, endedBy: "gap" as const, tools: 3 }))),
  );
  assert.deepEqual(basis, {
    basis: "all",
    blocked: null,
    excludedRuns: 0,
    since: null,
    mixed: false,
  });
});

test("a busy server without turn ids is mixed: its guessed runs end at caps, so workflows are hidden", () => {
  const counts = counted(
    times(40, (i) => ({
      source: "inferred" as const,
      endedBy: i % 3 === 0 ? ("gap" as const) : ("cap" as const),
      tools: 6,
    })),
  );
  assert.equal(runsLookMixed(counts), true);
  const basis = chooseRunBasis(counts);
  assert.equal(basis.basis, "none");
  assert.equal(basis.blocked, "mixed_runs");
  assert.equal(basis.excludedRuns, 40);
  assert.equal(minesRun(basis.basis, "inferred"), false);
});

test("too few guessed runs say nothing about mixing", () => {
  const counts = counted(
    times(MIN_INFERRED_FOR_MIX - 1, () => ({
      source: "inferred" as const,
      endedBy: "cap" as const,
      tools: 4,
    })),
  );
  assert.equal(runsLookMixed(counts), false);
  assert.equal(chooseRunBasis(counts).basis, "all");
});

test("once turn ids arrive in enough runs, the guessed ones are left out and the reading starts there", () => {
  const fixedAt = new Date("2026-09-25T08:00:00Z");
  const counts = counted([
    ...times(200, () => ({ source: "inferred" as const, endedBy: "gap" as const, tools: 3 })),
    ...times(MIN_EXACT_RUNS, (i) => ({
      source: "declared" as const,
      tools: 3,
      at: new Date(fixedAt.getTime() + i * 60_000),
    })),
  ]);
  const basis = chooseRunBasis(counts);
  assert.equal(basis.basis, "exact");
  assert.equal(basis.since, fixedAt.toISOString());
  assert.equal(basis.excludedRuns, 200);
  assert.equal(minesRun("exact", "declared"), true);
  assert.equal(minesRun("exact", "otlp"), true);
  assert.equal(minesRun("exact", "inferred"), false);
});

test("a few exact runs beside many guessed ones keep everything, unless the guessed ones are mixed", () => {
  const few = times(5, () => ({ source: "declared" as const, tools: 3 }));
  const calm = chooseRunBasis(
    counted([
      ...few,
      ...times(50, () => ({ source: "inferred" as const, endedBy: "gap" as const, tools: 3 })),
    ]),
  );
  assert.equal(calm.basis, "all");
  const mixed = chooseRunBasis(
    counted([
      ...few,
      ...times(50, () => ({ source: "inferred" as const, endedBy: "cap" as const, tools: 3 })),
    ]),
  );
  assert.equal(mixed.basis, "exact", "mixed guesses are worse than a thin exact reading");
  assert.equal(mixed.blocked, null);
  assert.equal(mixed.mixed, true);
});

test("runs that never call a tool block workflows with the reason; no runs block nothing", () => {
  const searchOnly = chooseRunBasis(
    counted(times(30, () => ({ source: "inferred" as const, tools: 0 }))),
  );
  assert.equal(searchOnly.blocked, "no_tool_calls");
  assert.equal(searchOnly.basis, "none");
  assert.equal(chooseRunBasis(emptyRunBasisCounts()).blocked, null);
});

test("OpenTelemetry runs are exact: one trace is one run", () => {
  const basis = chooseRunBasis(
    counted(times(10, () => ({ source: "otlp" as const, endedBy: "idle" as const, tools: 3 }))),
  );
  assert.equal(basis.basis, "all");
  assert.equal(basis.mixed, false);
});
