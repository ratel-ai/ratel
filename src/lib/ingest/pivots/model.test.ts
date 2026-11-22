import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_KEYS, USER_KEYS } from "@/lib/ingest/otlp/attr-resolve";
import {
  movePivot,
  PIVOT_LIMIT,
  PIVOT_PRESETS,
  type Pivot,
  pivotKeys,
  planPivot,
  presetFor,
  sortPivots,
  validateCustomKey,
  validateLabel,
} from "./model";

/** RC-881: the pure rules of a project's pivots (no I/O). */

function pivot(key: string, position: number, presetId: string | null = null): Pivot {
  return { key, label: key, presetId, position };
}

test("presets: end user, session, environment and client company, each with ordered keys", () => {
  assert.deepEqual(
    PIVOT_PRESETS.map((preset) => preset.id),
    ["end_user", "session", "environment", "client"],
  );
  assert.deepEqual(presetFor("end_user")?.keys, USER_KEYS);
  assert.deepEqual(presetFor("session")?.keys, SESSION_KEYS);
  assert.deepEqual(presetFor("environment")?.keys, [
    "deployment.environment.name",
    "deployment.environment",
  ]);
  assert.deepEqual(presetFor("client")?.keys, ["enduser.org", "tenant.id"]);
  assert.equal(presetFor("nope"), null);
});

test("pivotKeys: a preset reads its preset's keys, a custom pivot its one key", () => {
  assert.deepEqual(pivotKeys(pivot("client", 0, "client")), ["enduser.org", "tenant.id"]);
  assert.deepEqual(pivotKeys(pivot("customer.tier", 0)), ["customer.tier"]);
});

test("validateCustomKey: trims, accepts attribute keys, refuses empty, long, odd characters and preset ids", () => {
  assert.deepEqual(validateCustomKey("  customer.tier "), { ok: true, value: "customer.tier" });
  assert.deepEqual(validateCustomKey("app/region-1:eu_west"), {
    ok: true,
    value: "app/region-1:eu_west",
  });
  assert.equal(validateCustomKey("").ok, false);
  assert.equal(validateCustomKey("   ").ok, false);
  assert.equal(validateCustomKey("a".repeat(129)).ok, false);
  assert.equal(validateCustomKey("has space").ok, false);
  assert.equal(validateCustomKey('quote"d').ok, false);
  assert.equal(validateCustomKey("client").ok, false);
  assert.equal(validateCustomKey(42).ok, false);
});

test("validateLabel: trims and refuses empty or over 40 characters", () => {
  assert.deepEqual(validateLabel("  Client company "), { ok: true, value: "Client company" });
  assert.equal(validateLabel("").ok, false);
  assert.equal(validateLabel("x".repeat(41)).ok, false);
  assert.equal(validateLabel(null).ok, false);
});

test("planPivot: a preset gets its id as key, its name as default label, the next position", () => {
  const plan = planPivot([pivot("customer.tier", 0)], { presetId: "client" });
  assert.deepEqual(plan, {
    ok: true,
    pivot: { key: "client", label: "Client company", presetId: "client", position: 1 },
  });
});

test("planPivot: a custom key gets its key as default label, or the label given", () => {
  assert.deepEqual(planPivot([], { key: "customer.tier" }), {
    ok: true,
    pivot: { key: "customer.tier", label: "customer.tier", presetId: null, position: 0 },
  });
  assert.deepEqual(planPivot([], { key: "customer.tier", label: "Tier" }), {
    ok: true,
    pivot: { key: "customer.tier", label: "Tier", presetId: null, position: 0 },
  });
});

test("planPivot: refuses an unknown preset, a bad key, a bad label and a duplicate", () => {
  assert.equal(planPivot([], { presetId: "nope" }).ok, false);
  assert.equal(planPivot([], { key: "bad key" }).ok, false);
  assert.equal(planPivot([], { key: "ok", label: "x".repeat(41) }).ok, false);
  const existing = [pivot("client", 0, "client"), pivot("customer.tier", 1)];
  assert.deepEqual(planPivot(existing, { presetId: "client" }), { ok: false, error: "duplicate" });
  assert.deepEqual(planPivot(existing, { key: "customer.tier" }), {
    ok: false,
    error: "duplicate",
  });
});

test("planPivot: refuses a sixth pivot", () => {
  const five = Array.from({ length: PIVOT_LIMIT }, (_, index) => pivot(`k${index}`, index));
  assert.equal(PIVOT_LIMIT, 5);
  assert.deepEqual(planPivot(five, { key: "k5" }), { ok: false, error: "limit" });
  assert.equal(planPivot(five.slice(0, 4), { key: "k5" }).ok, true);
});

test("planPivot: the next position follows the highest, even with gaps", () => {
  const plan = planPivot([pivot("a", 0), pivot("b", 7)], { key: "c" });
  assert.equal(plan.ok && plan.pivot.position, 8);
});

test("sortPivots: by position, then key; the input is not changed", () => {
  const input = [pivot("b", 1), pivot("c", 0), pivot("a", 1)];
  assert.deepEqual(
    sortPivots(input).map((entry) => entry.key),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    input.map((entry) => entry.key),
    ["b", "c", "a"],
  );
});

test("movePivot: up and down swap with the neighbour and renumber from 0", () => {
  const pivots = [pivot("a", 0), pivot("b", 3), pivot("c", 9)];
  assert.deepEqual(movePivot(pivots, "c", "up"), ["a", "c", "b"]);
  assert.deepEqual(movePivot(pivots, "a", "down"), ["b", "a", "c"]);
});

test("movePivot: an edge move keeps the order, an unknown key is null", () => {
  const pivots = [pivot("a", 0), pivot("b", 1)];
  assert.deepEqual(movePivot(pivots, "a", "up"), ["a", "b"]);
  assert.deepEqual(movePivot(pivots, "b", "down"), ["a", "b"]);
  assert.equal(movePivot(pivots, "z", "up"), null);
});
