import assert from "node:assert/strict";
import { test } from "node:test";
import { type FunnelOrder, type FunnelStep, funnelQuery } from "@/lib/contracts/query";
import { type FunnelTrace, funnelSteps, passedSteps } from "@/lib/synthesis/metrics/funnel";

const use = (type: "tool" | "skill", name: string): FunnelStep => ({
  name,
  condition: { type, name },
});
const NO_ERROR: FunnelStep = { name: "ok", condition: { type: "no_error" } };
const SEARCH_READ = [use("tool", "search"), use("tool", "read")];

/** "search" is a tool, "/triage" a skill. */
function trace(path: string, holds: boolean[] = []): FunnelTrace {
  const steps = path
    .split(" ")
    .filter(Boolean)
    .map((name) =>
      name.startsWith("/")
        ? { kind: "skill" as const, name: name.slice(1) }
        : { kind: "tool" as const, name },
    );
  return { steps, holds };
}

function passed(path: string, steps: FunnelStep[], order: FunnelOrder, holds?: boolean[]) {
  return passedSteps(trace(path, holds), funnelQuery(steps, { order }));
}

test("in order, each step comes after the one before", () => {
  assert.equal(passed("search read", SEARCH_READ, "in_order"), 2);
  assert.equal(passed("search other read", SEARCH_READ, "in_order"), 2);
  assert.equal(passed("read search", SEARCH_READ, "in_order"), 1);
  assert.equal(passed("read search read", SEARCH_READ, "in_order"), 2);
  // One call does not meet two steps.
  const twice = [use("tool", "search"), use("tool", "search")];
  assert.equal(passed("search", twice, "in_order"), 1);
  assert.equal(passed("search search", twice, "in_order"), 2);
});

test("in any order, each step only has to happen", () => {
  assert.equal(passed("read search", SEARCH_READ, "any_order"), 2);
  assert.equal(passed("read", SEARCH_READ, "any_order"), 0);
});

test("a trace that skips a step stops there, in both orders", () => {
  const steps = [...SEARCH_READ, use("tool", "answer")];
  for (const order of ["in_order", "any_order"] as const)
    assert.equal(passed("search answer", steps, order), 1);
});

test("a skill is no tool of its name, and a fact of the trace holds at any place", () => {
  assert.equal(passed("triage", [use("skill", "triage")], "in_order"), 0);
  const steps = [use("skill", "triage"), NO_ERROR, use("tool", "read")];
  assert.equal(passed("/triage read", steps, "in_order", [false, true, false]), 3);
  assert.equal(passed("/triage read", steps, "in_order", [false, false, false]), 1);
});

test("each step has its count and its share of the step before", () => {
  const steps = funnelSteps(
    [trace("search read"), trace("search"), trace("search"), trace("search read"), trace("")],
    funnelQuery([...SEARCH_READ, use("tool", "answer"), use("tool", "send")]),
  );
  assert.deepEqual(
    steps.map(({ count, conversion }) => [count, conversion]),
    [
      [4, null],
      [2, 0.5],
      [0, 0],
      [0, null],
    ],
  );
});

test("a funnel with no trace is empty, not an error", () => {
  assert.deepEqual(
    funnelSteps([], funnelQuery(SEARCH_READ)).map(({ count, conversion }) => [count, conversion]),
    [
      [0, null],
      [0, null],
    ],
  );
});
