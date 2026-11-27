import assert from "node:assert/strict";
import { test } from "node:test";
import { healthUnlock, healthUnlockLine, isHealthUnlocked } from "@/lib/views/health/unlock";

const READ_AT = "2026-11-20T10:00:00.000Z";

test("a reading at the floor unlocks Agent health", () => {
  assert.deepEqual(healthUnlock({ turns: 50, floor: 50, computedAt: READ_AT }), {
    unlocked: true,
  });
  assert.equal(isHealthUnlocked({ turns: 120, floor: 50, computedAt: READ_AT }), true);
});

test("a reading under the floor stays locked, with how far it is", () => {
  assert.deepEqual(healthUnlock({ turns: 36, floor: 50, computedAt: READ_AT }), {
    unlocked: false,
    turns: 36,
    floor: 50,
  });
  assert.equal(isHealthUnlocked({ turns: 49, floor: 50, computedAt: READ_AT }), false);
});

test("no reading yet is locked, however many turns arrived", () => {
  assert.deepEqual(healthUnlock({ turns: 64, floor: 50, computedAt: null }), {
    unlocked: false,
    turns: 64,
    floor: 50,
  });
});

test("no turns is locked, never ready at a zero floor", () => {
  assert.equal(isHealthUnlocked({ turns: 0, floor: 0, computedAt: READ_AT }), false);
});

test("the low-confidence floor the model carries is the floor (toolRunInsights)", () => {
  // Agent health shows a reading from 10 turns on, marked low confidence: so does the Overview.
  assert.equal(isHealthUnlocked({ turns: 12, floor: 10, computedAt: READ_AT }), true);
});

test("the progress line says the floor and how far the turns are", () => {
  assert.equal(
    healthUnlockLine({ unlocked: false, turns: 36, floor: 50 }),
    "Agent health unlocks at 50 turns · 36/50",
  );
  assert.equal(
    healthUnlockLine({ unlocked: false, turns: 1200, floor: 1500 }),
    "Agent health unlocks at 1,500 turns · 1,200/1,500",
  );
});

test("enough turns with no reading yet says the first reading is being built", () => {
  assert.equal(
    healthUnlockLine({ unlocked: false, turns: 64, floor: 50 }),
    "Agent health is building its first reading",
  );
});
