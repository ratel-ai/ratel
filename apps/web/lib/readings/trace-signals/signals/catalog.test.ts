import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_FLOORS,
  FIX_SAFETY,
  PHASE_1_KINDS,
  resolveFloors,
  SIGNAL_CATALOG,
} from "@/lib/readings/trace-signals/signals/catalog";
import {
  median,
  quantile,
  Reservoir,
  wilsonHigh,
  wilsonLow,
} from "@/lib/readings/trace-signals/signals/severity";
import { SIGNAL_KINDS } from "@/lib/readings/trace-signals/view";

test("every kind has a subject, a tier, a fix route with its safety, and floors", () => {
  for (const kind of SIGNAL_KINDS) {
    const entry = SIGNAL_CATALOG[kind];
    assert.equal(entry.kind, kind);
    assert.ok(entry.subjectKind, `${kind} subject`);
    assert.equal(entry.tier, "deterministic");
    assert.ok(entry.fixRoute, `${kind} route`);
    assert.equal(entry.fixSafety, FIX_SAFETY[entry.fixRoute]);
    if (entry.phase === 1) {
      assert.ok(Object.keys(entry.floors).length > 0, `${kind} floors`);
      for (const [name, value] of Object.entries(entry.floors)) {
        assert.ok(Number.isFinite(value) && value > 0, `${kind}.${name}`);
      }
    }
  }
});

test("cooccurring_intents is declared for Phase 2 and left out of Phase 1", () => {
  assert.equal(SIGNAL_CATALOG.cooccurring_intents.phase, 2);
  assert.ok(!PHASE_1_KINDS.includes("cooccurring_intents"));
  assert.equal(PHASE_1_KINDS.length, SIGNAL_KINDS.length - 1);
});

test("risky routes never auto-apply", () => {
  for (const route of [
    "retire_tool",
    "workflow_skill",
    "disambiguate_pair",
    "lower_top_k",
  ] as const) {
    assert.equal(FIX_SAFETY[route], "needs_approval");
  }
  assert.equal(FIX_SAFETY.rewrite_description, "safe");
});

test("floors take env overrides and reject nonsense", () => {
  const saved = { ...process.env };
  try {
    process.env.TRACE_SIGNALS_MAGNET_MIN_IMPRESSIONS = "80";
    process.env.TRACE_SIGNALS_FIRST_TRY_MISS_MIN_LOW = "1.5";
    process.env.TRACE_SIGNALS_MAGNET_MIN_TOP3_IMPRESSIONS = "35";
    const floors = resolveFloors();
    assert.equal(floors.magnet.minImpressions, 80);
    assert.equal(floors.magnet.minTop3Impressions, 35);
    assert.equal(DEFAULT_FLOORS.magnet.minTop3Impressions, 20);
    assert.equal(DEFAULT_FLOORS.magnet.minTop3Low, 0.05);
    assert.equal(floors.first_try_miss.minLow, 0.15, "a share above 1 falls back to the default");
  } finally {
    process.env = saved;
  }
});

test("severity helpers: Wilson bounds, quantiles, a deterministic reservoir", () => {
  assert.equal(wilsonLow(0, 0), 0);
  assert.equal(wilsonHigh(0, 0), 1);
  assert.ok(wilsonLow(5, 10) < 0.5 && wilsonHigh(5, 10) > 0.5);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(quantile([], 0.5), null);
  const fill = () => {
    const r = new Reservoir<number>(5, "seed");
    for (let i = 0; i < 1_000; i++) r.add(i);
    return r;
  };
  assert.deepEqual(fill().values(), fill().values());
  assert.equal(fill().total, 1_000);
  assert.equal(fill().values().length, 5);
});
