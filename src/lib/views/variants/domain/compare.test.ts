import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapInterval, percentile } from "./bootstrap";
import {
  cheaperSuggestion,
  compareVariants,
  MIN_VARIANT_RUNS,
  pickBaseline,
  rate,
  type SampledTrace,
  type VariantSample,
  variantMetrics,
} from "./compare";

/** RC-870: per-variant figures with intervals, the baseline, the minimum-sample warning and the cheaper-model rule. */

function traces(
  n: number,
  opts: { costUsd: number; errors?: number; durationMs?: (i: number) => number },
): SampledTrace[] {
  return Array.from({ length: n }, (_, i) => ({
    durationMs: opts.durationMs?.(i) ?? 1_000 + i * 10,
    costUsd: opts.costUsd,
    hasError: i < (opts.errors ?? 0),
  }));
}

function sample(
  name: string,
  runs: number,
  over: Partial<VariantSample> & { costUsd?: number; errors?: number } = {},
): VariantSample {
  const errors = over.errors ?? 0;
  return {
    name,
    attrs: {},
    runs,
    errors,
    inputTokens: runs * 100,
    outputTokens: runs * 20,
    traces: traces(runs, { costUsd: over.costUsd ?? 0.01, errors }),
    health: {},
    scorer: null,
    ...over,
  };
}

test("rate: a Wilson interval around the proportion, null without a measured trace", () => {
  const value = rate(5, 50)!;
  assert.equal(value.value, 0.1);
  assert.equal(value.n, 50);
  assert.ok(value.interval.low > 0.04 && value.interval.low < 0.05, `low ${value.interval.low}`);
  assert.ok(
    value.interval.high > 0.21 && value.interval.high < 0.22,
    `high ${value.interval.high}`,
  );
  assert.deepEqual(rate(0, 10)!.interval.low, 0);
  assert.equal(rate(0, 0), null);
});

test("bootstrap: the same seed gives the same interval, another seed may not, and it brackets the statistic", () => {
  const values = Array.from({ length: 80 }, (_, i) => (i * 37) % 101);
  const median = (sample: readonly number[]) =>
    percentile(
      [...sample].sort((a, b) => a - b),
      0.5,
    );
  const first = bootstrapInterval(values, median, "exp:a:p50")!;
  const again = bootstrapInterval(values, median, "exp:a:p50")!;
  assert.deepEqual(first, again);
  assert.notDeepEqual(bootstrapInterval(values, median, "exp:b:p50"), first);
  const point = median(values);
  assert.ok(first.low <= point && point <= first.high, `${first.low} <= ${point} <= ${first.high}`);
  assert.equal(bootstrapInterval([], median, "x"), null);
});

test("percentile interpolates like percentile_cont", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10], 0.95), 10);
  assert.equal(percentile([0, 100], 0.95), 95);
});

test("variant metrics: latency and cost per successful trace carry seeded bootstrap intervals", () => {
  const input = sample("cheap", 40, { costUsd: 0.02, errors: 4 });
  const first = variantMetrics(input, false, "exp:cheap");
  assert.deepEqual(variantMetrics(input, false, "exp:cheap"), first);
  assert.equal(first.errorRate!.value, 0.1);
  // 40 traces at $0.02 over 36 successes.
  assert.ok(Math.abs(first.costPerSuccessUsd!.value - (40 * 0.02) / 36) < 1e-12);
  assert.ok(first.costPerSuccessUsd!.interval.low <= first.costPerSuccessUsd!.value);
  assert.ok(first.costPerSuccessUsd!.interval.high >= first.costPerSuccessUsd!.value);
  assert.equal(
    first.latencyP50Ms!.value,
    percentile(
      input.traces.map((t) => t.durationMs),
      0.5,
    ),
  );
  assert.ok(first.latencyP95Ms!.value > first.latencyP50Ms!.value);
  assert.ok(first.latencyP95Ms!.interval.low <= first.latencyP95Ms!.value);
  assert.deepEqual(first.tokens, { input: 4_000, output: 800, perRun: 120 });
});

test("health signals and the scorer pass rate are rates with intervals; unmeasured kinds are left out", () => {
  const metrics = variantMetrics(
    sample("a", 40, { health: { tool_errors: { n: 40, hits: 8 } }, scorer: { n: 30, passed: 27 } }),
    false,
    "s",
  );
  assert.deepEqual(
    metrics.health.map((h) => [h.kind, h.rate.value]),
    [["tool_errors", 0.2]],
  );
  assert.equal(metrics.scorerPassRate!.value, 0.9);
  assert.ok(metrics.scorerPassRate!.interval.low < 0.9);
});

test("minimum sample: a variant under it shows a warning; at it, none", () => {
  const under = variantMetrics(sample("a", MIN_VARIANT_RUNS - 1), false, "s");
  assert.equal(under.belowMinimumSample, true);
  assert.match(under.warning!, /29 runs, under the 30/);
  const at = variantMetrics(sample("a", MIN_VARIANT_RUNS), false, "s");
  assert.equal(at.belowMinimumSample, false);
  assert.equal(at.warning, null);
});

test("baseline: `baseline` or `control` by name, else the most runs, and it says which", () => {
  assert.deepEqual(
    pickBaseline([
      { name: "big", runs: 900 },
      { name: "Control", runs: 10 },
    ]),
    { name: "Control", reason: "named" },
  );
  assert.deepEqual(
    pickBaseline([
      { name: "control", runs: 9 },
      { name: "baseline", runs: 10 },
    ]),
    { name: "baseline", reason: "named" },
  );
  assert.deepEqual(
    pickBaseline([
      { name: "b", runs: 50 },
      { name: "a", runs: 80 },
    ]),
    { name: "a", reason: "most_runs" },
  );
  assert.deepEqual(
    pickBaseline([
      { name: "b", runs: 50 },
      { name: "a", runs: 50 },
    ]),
    { name: "a", reason: "most_runs" },
  );
  assert.equal(pickBaseline([]), null);
});

test("cheaper model: a cheaper variant inside the baseline's quality interval is suggested", () => {
  const result = compareVariants("checkout", [
    sample("baseline", 200, { costUsd: 0.05, errors: 10, scorer: { n: 200, passed: 180 } }),
    sample("haiku", 200, { costUsd: 0.01, errors: 12, scorer: { n: 200, passed: 172 } }),
  ]);
  assert.deepEqual(result.baseline, { name: "baseline", reason: "named" });
  assert.equal(result.suggestions.length, 1);
  const [suggestion] = result.suggestions;
  assert.equal(suggestion!.variant, "haiku");
  assert.deepEqual(suggestion!.qualityBasis, ["error_rate", "scorer_pass_rate"]);
  assert.ok(suggestion!.savingsFraction > 0.7);
});

test("cheaper model: just outside the baseline's error interval, or its pass interval, no suggestion", () => {
  const base = variantMetrics(
    sample("baseline", 200, { costUsd: 0.05, errors: 10, scorer: { n: 200, passed: 180 } }),
    true,
    "b",
  );
  const errorHigh = Math.ceil(base.errorRate!.interval.high * 200);
  const passLow = Math.floor(base.scorerPassRate!.interval.low * 200);
  const cheap = (errors: number, passed: number) =>
    variantMetrics(
      sample("haiku", 200, { costUsd: 0.01, errors, scorer: { n: 200, passed } }),
      false,
      "h",
    );

  // Inside on both: suggested.
  assert.ok(cheaperSuggestion(cheap(errorHigh - 1, passLow + 1), base));
  // Error rate just above the baseline's upper bound.
  assert.equal(cheaperSuggestion(cheap(errorHigh, passLow + 1), base), null);
  // Pass rate just below the baseline's lower bound.
  assert.equal(cheaperSuggestion(cheap(errorHigh - 1, passLow), base), null);
});

test("cheaper model: not cheaper, under the minimum sample, or unscored against a scored baseline: no suggestion", () => {
  const base = variantMetrics(
    sample("baseline", 100, { costUsd: 0.05, scorer: { n: 100, passed: 90 } }),
    true,
    "b",
  );
  const pricier = variantMetrics(
    sample("opus", 100, { costUsd: 0.06, scorer: { n: 100, passed: 95 } }),
    false,
    "o",
  );
  assert.equal(cheaperSuggestion(pricier, base), null);
  const small = variantMetrics(
    sample("haiku", MIN_VARIANT_RUNS - 1, { costUsd: 0.01, scorer: { n: 29, passed: 29 } }),
    false,
    "h",
  );
  assert.equal(cheaperSuggestion(small, base), null);
  const unscored = variantMetrics(sample("haiku", 100, { costUsd: 0.01 }), false, "h");
  assert.equal(cheaperSuggestion(unscored, base), null);
});

test("cheaper model without scorers on either side rests on the error rate alone and says so", () => {
  const result = compareVariants("checkout", [
    sample("a", 100, { costUsd: 0.05 }),
    sample("b", 60, { costUsd: 0.02 }),
  ]);
  assert.deepEqual(result.baseline, { name: "a", reason: "most_runs" });
  assert.deepEqual(
    result.suggestions.map((s) => [s.variant, s.qualityBasis]),
    [["b", ["error_rate"]]],
  );
});
