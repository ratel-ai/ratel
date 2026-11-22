import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDefinition } from "./domain/config";
import type { Scorer } from "./domain/types";
import { configOf, formOf, thresholdOf } from "./form";
import { lastDays, STARTER_DEFINITIONS, scorerRows } from "./view";

const BASE = {
  id: "s",
  name: "S",
  scope: "task",
  taskId: "t",
  enabled: true,
  goodThreshold: 0.5,
  version: 1,
} as const;

test("each kind's form round-trips to a config the domain accepts", () => {
  for (const definition of Object.values(STARTER_DEFINITIONS)) {
    const scorer = { ...BASE, ...definition } as Scorer;
    const back = configOf(scorer.kind, formOf(scorer));
    assert.ok(back.ok);
    assert.deepEqual(parseDefinition(scorer.kind, back.config), definition);
  }
});

test("check values read as numbers, booleans and JSON when they look like one", () => {
  const form = formOf({
    ...BASE,
    kind: "check",
    config: { path: "toolNames", op: "contains", value: "notify" },
  });
  assert.deepEqual(configOf("check", { ...form, value: "42" }), {
    ok: true,
    config: { path: "toolNames", op: "contains", value: 42 },
  });
  assert.deepEqual(configOf("check", { ...form, value: "true" }), {
    ok: true,
    config: { path: "toolNames", op: "contains", value: true },
  });
  assert.deepEqual(configOf("check", { ...form, value: '["a"]' }), {
    ok: true,
    config: { path: "toolNames", op: "contains", value: ["a"] },
  });
  assert.deepEqual(configOf("check", { ...form, op: "exists" }), {
    ok: true,
    config: { path: "toolNames", op: "exists" },
  });
  assert.deepEqual(configOf("expression", { ...form, logic: "{" }), {
    ok: false,
    error: "The rule is not valid JSON.",
  });
  assert.equal(thresholdOf({ ...form, threshold: "80" }), 0.8);
  assert.equal(thresholdOf({ ...form, threshold: "180" }), null);
});

test("scorerRows reads the window's pass rate and trend", () => {
  const days = lastDays("2026-11-03", 3);
  assert.deepEqual(days, ["2026-11-01", "2026-11-02", "2026-11-03"]);
  const [row] = scorerRows({
    own: [{ ...BASE, ...STARTER_DEFINITIONS.check } as Scorer],
    builtIn: [],
    rates: new Map([
      [
        "s",
        [
          { day: "2026-10-01", n: 9, passed: 0 },
          { day: "2026-11-01", n: 4, passed: 3 },
          { day: "2026-11-03", n: 4, passed: 1 },
        ],
      ],
    ]),
    days,
    hrefOf: (id) => `/x/${id}`,
  });
  assert.deepEqual(row, {
    id: "s",
    name: "S",
    kind: "Field check",
    enabled: true,
    builtIn: false,
    passRate: 0.5,
    trend: [0.75, 0, 0.25],
    href: "/x/s",
  });
});
