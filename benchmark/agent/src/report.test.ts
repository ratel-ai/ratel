import { describe, expect, it } from "vitest";
import {
  corpusOf,
  failureTaxonomy,
  mean,
  median,
  renderReport,
  retrievalByPoolSize,
  savingsByModel,
  statsByArmModel,
  subsetOf,
} from "./report.js";
import type { Arm, CellResult } from "./types.js";

function retrievalRow(over: {
  scenario_id: string;
  target_pool_size: number;
  recall_at_k: number;
  reciprocal_rank: number;
  hit_at_k: boolean;
  k?: number;
  gold_count?: number;
  ndcg_at_k?: number;
}) {
  return {
    scenario_id: over.scenario_id,
    target_pool_size: over.target_pool_size,
    actual_pool_size: over.target_pool_size,
    k: over.k ?? 5,
    pool_size: over.target_pool_size,
    gold_count: over.gold_count ?? 1,
    recall_at_k: over.recall_at_k,
    precision_at_k: 0,
    reciprocal_rank: over.reciprocal_rank,
    hit_at_k: over.hit_at_k,
    ndcg_at_k: over.ndcg_at_k ?? over.reciprocal_rank,
  };
}

function cell(over: Partial<CellResult>): CellResult {
  return {
    scenario_id: "s1",
    arm: "control-baseline" as Arm,
    model: "gpt-5.4-mini",
    run_index: 0,
    ratel_version: "test",
    catalog_size: 5,
    pool_size: 30,
    seed: 42,
    input_tokens: 1000,
    output_tokens: 200,
    cached_input_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 1200,
    tool_calls_total: 1,
    tool_calls_unique: 1,
    gateway_calls: 0,
    non_gateway_calls: 1,
    turns: 1,
    programmatic_verdict: "pass",
    judge_verdict: "n/a",
    final_text: "ok",
    finish_reason: "stop",
    error: null,
    wall_ms: 100,
    dollar_cost: 0.01,
    tool_calls: [],
    effective_tool_ids: [],
    ...over,
  };
}

describe("statistics helpers", () => {
  it("median of even-length array averages middle two", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("median of odd-length picks middle", () => {
    expect(median([1, 5, 3])).toBe(3);
  });

  it("mean returns 0 for empty", () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
  });
});

describe("statsByArmModel", () => {
  it("groups by (arm, model) and reports per-scenario averaged success + means", () => {
    // Single-scenario case: per-scenario mean equals the run-level mean,
    // so the headline numbers are direct averages of the input cells.
    const cells = [
      cell({ arm: "control-baseline", input_tokens: 1000 }),
      cell({
        arm: "control-baseline",
        input_tokens: 1500,
        run_index: 1,
        programmatic_verdict: "fail",
      }),
      cell({ arm: "ratel-full", input_tokens: 200 }),
      cell({ arm: "ratel-full", input_tokens: 300, run_index: 1 }),
    ];
    const stats = statsByArmModel(cells);
    expect(stats).toHaveLength(2);
    const control = stats.find((s) => s.arm === "control-baseline");
    const ratel = stats.find((s) => s.arm === "ratel-full");
    expect(control?.n).toBe(2);
    expect(control?.scenarios).toBe(1);
    expect(control?.success_rate).toBe(0.5);
    expect(control?.mean_input_tokens).toBe(1250);
    expect(ratel?.mean_input_tokens).toBe(250);
    expect(ratel?.success_rate).toBe(1);
  });

  it("averages per-scenario means across scenarios — equal weight per scenario, regardless of run count", () => {
    // Scenario A: 5 runs, 4 pass / 1 fail → success rate 0.8
    // Scenario B: 2 runs, 1 pass / 1 fail → success rate 0.5
    // Headline success_rate = mean(0.8, 0.5) = 0.65, NOT 5/7 ≈ 0.714 (that
    // would be a flat global mean that lets a high-run-count scenario drown
    // out the others).
    const cells = [
      ...Array.from({ length: 4 }, (_, i) =>
        cell({
          scenario_id: "A",
          arm: "ratel-full",
          run_index: i,
          programmatic_verdict: "pass",
          input_tokens: 100,
          wall_ms: 100,
        }),
      ),
      cell({
        scenario_id: "A",
        arm: "ratel-full",
        run_index: 4,
        programmatic_verdict: "fail",
        input_tokens: 100,
        wall_ms: 100,
      }),
      cell({
        scenario_id: "B",
        arm: "ratel-full",
        run_index: 0,
        programmatic_verdict: "pass",
        input_tokens: 500,
        wall_ms: 500,
      }),
      cell({
        scenario_id: "B",
        arm: "ratel-full",
        run_index: 1,
        programmatic_verdict: "fail",
        input_tokens: 500,
        wall_ms: 500,
      }),
    ];
    const stats = statsByArmModel(cells);
    const ratel = stats.find((s) => s.arm === "ratel-full");
    expect(ratel?.scenarios).toBe(2);
    expect(ratel?.n).toBe(7);
    expect(ratel?.success_rate).toBeCloseTo(0.65, 5);
    // Per-scenario mean input: A = 100, B = 500 → headline mean(100, 500) = 300.
    expect(ratel?.mean_input_tokens).toBeCloseTo(300, 5);
    // Wall follows the same shape: A = 100, B = 500 → mean = 300.
    expect(ratel?.mean_wall_ms).toBeCloseTo(300, 5);
  });

  it("aggregates pool-size-agnostic arms (e.g. oracle) into a single row with pool_size=null", () => {
    const cells = [
      // Oracle has pool_size: null and varying catalog sizes (1 or 2 gold tools).
      cell({
        scenario_id: "s1",
        arm: "control-oracle",
        pool_size: null,
        catalog_size: 1,
        input_tokens: 100,
      }),
      cell({
        scenario_id: "s2",
        arm: "control-oracle",
        pool_size: null,
        catalog_size: 2,
        input_tokens: 200,
      }),
      // Baseline parameterized by pool size.
      cell({ scenario_id: "s1", arm: "control-baseline", pool_size: 30, input_tokens: 1000 }),
    ];
    const stats = statsByArmModel(cells);
    const oracle = stats.find((s) => s.arm === "control-oracle");
    expect(oracle?.pool_size).toBeNull();
    expect(oracle?.scenarios).toBe(2);
    // Catalog column reveals the real per-scenario tool count for oracle (mean(1, 2) = 1.5).
    expect(oracle?.mean_catalog_size).toBeCloseTo(1.5, 5);
    expect(oracle?.mean_input_tokens).toBeCloseTo(150, 5);
  });

  it("emits one row per (arm, model, pool_size) so a sweep doesn't average across pools", () => {
    const cells = [
      cell({ arm: "control-baseline", pool_size: 180, input_tokens: 1500 }),
      cell({
        arm: "control-baseline",
        pool_size: 180,
        run_index: 1,
        input_tokens: 1500,
      }),
      cell({ arm: "ratel-full", pool_size: 180, input_tokens: 800 }),
      cell({ arm: "ratel-full", pool_size: 30, run_index: 1, input_tokens: 200 }),
    ];
    const stats = statsByArmModel(cells);
    expect(stats).toHaveLength(3);
    const control = stats.find((s) => s.arm === "control-baseline");
    const ratel180 = stats.find((s) => s.arm === "ratel-full" && s.pool_size === 180);
    const ratel30 = stats.find((s) => s.arm === "ratel-full" && s.pool_size === 30);
    expect(control?.pool_size).toBe(180);
    expect(control?.n).toBe(2);
    // The 180 and 30 ratel cells live in separate rows, each with its own input mean.
    expect(ratel180?.mean_input_tokens).toBe(800);
    expect(ratel30?.mean_input_tokens).toBe(200);
  });
});

describe("savingsByModel", () => {
  it("computes ratel vs control savings % across input, total, $, and wall", () => {
    const cells = [
      cell({
        arm: "control-baseline",
        input_tokens: 1000,
        total_tokens: 1200,
        dollar_cost: 0.01,
        wall_ms: 4000,
      }),
      cell({
        arm: "ratel-full",
        input_tokens: 250,
        total_tokens: 400,
        dollar_cost: 0.003,
        wall_ms: 1000,
      }),
      cell({
        arm: "control-oracle",
        input_tokens: 100,
        total_tokens: 200,
        dollar_cost: 0.001,
        wall_ms: 500,
      }),
    ];
    const [s] = savingsByModel(cells);
    expect(s.control_mean_input).toBe(1000);
    expect(s.ratel_mean_input).toBe(250);
    expect(s.input_savings_pct).toBeCloseTo(75, 5);
    expect(s.control_mean_total).toBe(1200);
    expect(s.ratel_mean_total).toBe(400);
    expect(s.total_savings_pct).toBeCloseTo((1 - 400 / 1200) * 100, 5);
    expect(s.control_mean_dollars).toBeCloseTo(0.01, 5);
    expect(s.ratel_mean_dollars).toBeCloseTo(0.003, 5);
    expect(s.dollar_savings_pct).toBeCloseTo(70, 5);
    expect(s.oracle_mean_input).toBe(100);
    // Wall savings: 4000 → 1000 = 75% saved.
    expect(s.control_mean_wall_ms).toBe(4000);
    expect(s.ratel_mean_wall_ms).toBe(1000);
    expect(s.wall_savings_pct).toBeCloseTo(75, 5);
  });

  it("skips models without both control and ratel arms", () => {
    const cells = [cell({ arm: "control-baseline" })];
    expect(savingsByModel(cells)).toHaveLength(0);
  });

  it("pairs control vs ratel within each pool size — sweeps emit one row per pool", () => {
    const cells = [
      // pool 30: ratel saves 50%
      cell({ arm: "control-baseline", pool_size: 30, input_tokens: 1000 }),
      cell({ arm: "ratel-full", pool_size: 30, input_tokens: 500 }),
      // pool 180: ratel saves 75%
      cell({ arm: "control-baseline", pool_size: 180, input_tokens: 4000 }),
      cell({ arm: "ratel-full", pool_size: 180, input_tokens: 1000 }),
    ];
    const rows = savingsByModel(cells);
    expect(rows).toHaveLength(2);
    const r30 = rows.find((s) => s.pool_size === 30);
    const r180 = rows.find((s) => s.pool_size === 180);
    expect(r30?.input_savings_pct).toBeCloseTo(50, 5);
    expect(r180?.input_savings_pct).toBeCloseTo(75, 5);
  });

  it("joins oracle by model alone — its agnostic row appears next to every per-pool savings row", () => {
    const cells = [
      // Oracle is pool-size-agnostic — one row per model.
      cell({ arm: "control-oracle", pool_size: null, catalog_size: 1, input_tokens: 100 }),
      cell({ arm: "control-baseline", pool_size: 30, input_tokens: 1000 }),
      cell({ arm: "ratel-full", pool_size: 30, input_tokens: 500 }),
      cell({ arm: "control-baseline", pool_size: 180, input_tokens: 4000 }),
      cell({ arm: "ratel-full", pool_size: 180, input_tokens: 1000 }),
    ];
    const rows = savingsByModel(cells);
    expect(rows).toHaveLength(2);
    // Oracle's mean_input is shown identically next to every pool row for the model.
    expect(rows[0].oracle_mean_input).toBe(100);
    expect(rows[1].oracle_mean_input).toBe(100);
  });
});

describe("corpusOf", () => {
  it("recognizes metatool single- and multi-tool ids", () => {
    expect(corpusOf("metatool-st-42")).toBe("metatool");
    expect(corpusOf("metatool-mt-7")).toBe("metatool");
  });
  it("recognizes toolret ids", () => {
    expect(corpusOf("toolret-001")).toBe("toolret");
  });
  it("falls back to 'other' for unprefixed ids", () => {
    expect(corpusOf("fs-001")).toBe("other");
    expect(corpusOf("anything-else")).toBe("other");
  });
});

describe("subsetOf", () => {
  it("buckets gold_count==1 as single-tool", () => {
    expect(subsetOf(1)).toBe("single-tool");
  });
  it("buckets gold_count>1 as multi-tool", () => {
    expect(subsetOf(2)).toBe("multi-tool");
    expect(subsetOf(5)).toBe("multi-tool");
  });
  it("treats gold_count==0 as single-tool (defensive default)", () => {
    expect(subsetOf(0)).toBe("single-tool");
  });
});

describe("retrievalByPoolSize", () => {
  it("aggregates by (corpus, subset, k, pool) and reports mean + median + hit rate", () => {
    const rows = [
      retrievalRow({
        scenario_id: "s1",
        target_pool_size: 30,
        recall_at_k: 1,
        reciprocal_rank: 1,
        hit_at_k: true,
      }),
      retrievalRow({
        scenario_id: "s2",
        target_pool_size: 30,
        recall_at_k: 0.5,
        reciprocal_rank: 0.5,
        hit_at_k: true,
      }),
      retrievalRow({
        scenario_id: "s1",
        target_pool_size: 150,
        recall_at_k: 0,
        reciprocal_rank: 0,
        hit_at_k: false,
      }),
    ];
    const summaries = retrievalByPoolSize(rows);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].corpus).toBe("other");
    expect(summaries[0].subset).toBe("single-tool");
    expect(summaries[0].k).toBe(5);
    expect(summaries[0].pool_size).toBe(30);
    expect(summaries[0].mean_recall).toBeCloseTo(0.75);
    expect(summaries[0].median_recall).toBeCloseTo(0.75);
    expect(summaries[0].hit_rate).toBe(1);
    expect(summaries[1].hit_rate).toBe(0);
  });

  it("aggregates nDCG into mean and median per cell", () => {
    const rows = [
      retrievalRow({
        scenario_id: "s1",
        target_pool_size: 30,
        recall_at_k: 1,
        reciprocal_rank: 1,
        hit_at_k: true,
        ndcg_at_k: 1,
      }),
      retrievalRow({
        scenario_id: "s2",
        target_pool_size: 30,
        recall_at_k: 0.5,
        reciprocal_rank: 0.5,
        hit_at_k: true,
        ndcg_at_k: 0.5,
      }),
      retrievalRow({
        scenario_id: "s3",
        target_pool_size: 30,
        recall_at_k: 0,
        reciprocal_rank: 0,
        hit_at_k: false,
        ndcg_at_k: 0,
      }),
    ];
    const [s] = retrievalByPoolSize(rows);
    expect(s.mean_ndcg).toBeCloseTo(0.5);
    expect(s.median_ndcg).toBeCloseTo(0.5);
  });

  it("splits single-tool and multi-tool rows into distinct subsets", () => {
    // Same corpus, same pool, same K — different gold_count.
    const rows = [
      retrievalRow({
        scenario_id: "metatool-st-1",
        target_pool_size: 30,
        recall_at_k: 1,
        reciprocal_rank: 1,
        hit_at_k: true,
      }),
      retrievalRow({
        scenario_id: "metatool-mt-1",
        target_pool_size: 30,
        recall_at_k: 0.5,
        reciprocal_rank: 1,
        hit_at_k: true,
        gold_count: 2,
      }),
    ];
    const summaries = retrievalByPoolSize(rows);
    expect(summaries).toHaveLength(2);
    const single = summaries.find((s) => s.subset === "single-tool");
    const multi = summaries.find((s) => s.subset === "multi-tool");
    expect(single?.n).toBe(1);
    expect(single?.mean_recall).toBe(1);
    expect(multi?.n).toBe(1);
    expect(multi?.mean_recall).toBeCloseTo(0.5);
  });

  it("splits rows by K cutoff", () => {
    const rows = [
      retrievalRow({
        scenario_id: "metatool-st-1",
        target_pool_size: 30,
        recall_at_k: 0,
        reciprocal_rank: 0,
        hit_at_k: false,
        k: 1,
      }),
      retrievalRow({
        scenario_id: "metatool-st-1",
        target_pool_size: 30,
        recall_at_k: 1,
        reciprocal_rank: 0.5,
        hit_at_k: true,
        k: 5,
      }),
    ];
    const summaries = retrievalByPoolSize(rows);
    expect(summaries.map((s) => s.k)).toEqual([1, 5]);
    expect(summaries[0].hit_rate).toBe(0);
    expect(summaries[1].hit_rate).toBe(1);
  });

  it("groups by corpus when scenario ids carry distinct prefixes", () => {
    const rows = [
      retrievalRow({
        scenario_id: "metatool-st-1",
        target_pool_size: 30,
        recall_at_k: 1,
        reciprocal_rank: 1,
        hit_at_k: true,
      }),
      retrievalRow({
        scenario_id: "metatool-st-2",
        target_pool_size: 30,
        recall_at_k: 0,
        reciprocal_rank: 0,
        hit_at_k: false,
      }),
      retrievalRow({
        scenario_id: "toolret-1",
        target_pool_size: 30,
        recall_at_k: 1,
        reciprocal_rank: 1,
        hit_at_k: true,
      }),
    ];
    const summaries = retrievalByPoolSize(rows);
    expect(summaries.map((s) => s.corpus)).toEqual(["metatool", "toolret"]);
    const meta = summaries.find((s) => s.corpus === "metatool");
    const tret = summaries.find((s) => s.corpus === "toolret");
    expect(meta?.n).toBe(2);
    expect(meta?.mean_recall).toBeCloseTo(0.5);
    expect(meta?.median_recall).toBeCloseTo(0.5);
    expect(tret?.n).toBe(1);
    expect(tret?.mean_recall).toBe(1);
  });

  it("median diverges from mean when the distribution is skewed (real MetaTool case)", () => {
    // Mirrors what we see on MetaTool retrieval: most queries hit gold at rank 1
    // (recall=1), but a long tail of misses pulls the mean below 1.
    const rows = [
      ...Array.from({ length: 7 }, (_, i) =>
        retrievalRow({
          scenario_id: `metatool-st-${i}`,
          target_pool_size: 100,
          recall_at_k: 1,
          reciprocal_rank: 1,
          hit_at_k: true,
        }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        retrievalRow({
          scenario_id: `metatool-st-${100 + i}`,
          target_pool_size: 100,
          recall_at_k: 0,
          reciprocal_rank: 0,
          hit_at_k: false,
        }),
      ),
    ];
    const [s] = retrievalByPoolSize(rows);
    expect(s.mean_recall).toBeCloseTo(0.7);
    expect(s.median_recall).toBe(1);
  });
});

describe("failureTaxonomy", () => {
  it("counts pass/fail/errored per (arm, model)", () => {
    const cells = [
      cell({ arm: "control-baseline", programmatic_verdict: "pass" }),
      cell({
        arm: "control-baseline",
        programmatic_verdict: "fail",
        tool_calls: [{ toolId: "wrong", args: {} }],
      }),
      cell({ arm: "control-baseline", programmatic_verdict: "fail", error: "timeout" }),
    ];
    const [t] = failureTaxonomy(cells);
    expect(t.pass).toBe(1);
    expect(t.fail).toBe(2);
    expect(t.errored).toBe(1);
    expect(t.missing_gold).toBe(1);
  });
});

describe("renderReport", () => {
  it("produces a markdown document with each panel", () => {
    const cells = [
      cell({
        arm: "control-baseline",
        input_tokens: 1000,
        total_tokens: 1200,
        dollar_cost: 0.01,
        wall_ms: 4000,
      }),
      cell({
        arm: "ratel-full",
        input_tokens: 250,
        total_tokens: 400,
        dollar_cost: 0.003,
        wall_ms: 1000,
      }),
      cell({
        arm: "control-oracle",
        input_tokens: 100,
        total_tokens: 200,
        dollar_cost: 0.001,
        wall_ms: 500,
      }),
    ];
    const md = renderReport({ cells, retrieval: [], generatedAt: new Date("2026-05-01") });
    expect(md).toContain("# Ratel benchmark report");
    expect(md).toContain("## Headline");
    expect(md).toContain("## Token savings");
    expect(md).toContain("## Retrieval quality");
    expect(md).toContain("## Failure taxonomy");
    // Variance-flags section is gone — mean-of-means doesn't compose with p90/median.
    expect(md).not.toContain("## Variance flags");
    expect(md).toContain("**75.0%**"); // input savings (and wall savings) both 75%
    expect(md).toContain("**70.0%**"); // dollar savings
    // Wall time is part of the headline + savings tables now.
    expect(md).toContain("mean wall");
  });

  it("renders pool-size-agnostic oracle rows with `pool: —` and a real Catalog count", () => {
    const cells = [
      // Two scenarios w/ different gold counts → oracle catalog mean = 1.5.
      cell({ scenario_id: "a", arm: "control-oracle", pool_size: null, catalog_size: 1 }),
      cell({ scenario_id: "b", arm: "control-oracle", pool_size: null, catalog_size: 2 }),
      cell({ arm: "control-baseline", pool_size: 30 }),
    ];
    const md = renderReport({ cells, retrieval: [], generatedAt: new Date("2026-05-01") });
    // Headline shows "—" in the pool column for the oracle row, and a real catalog count.
    expect(md).toMatch(/\| control-oracle \| [^|]+ \| — \|/);
    // The catalog column carries 1.5 for oracle (mean of gold counts 1 and 2).
    expect(md).toMatch(/control-oracle.*\| — \| 1\.5/);
    // Sweep arms keep their literal pool size in the pool column.
    expect(md).toMatch(/\| control-baseline \| [^|]+ \| 30 \|/);
  });

  it("renders one retrieval panel per (corpus, subset) when input spans both", () => {
    const retrieval = [
      retrievalRow({
        scenario_id: "metatool-st-1",
        target_pool_size: 100,
        recall_at_k: 1,
        reciprocal_rank: 1,
        hit_at_k: true,
      }),
      retrievalRow({
        scenario_id: "metatool-mt-1",
        target_pool_size: 100,
        recall_at_k: 0.5,
        reciprocal_rank: 1,
        hit_at_k: true,
        gold_count: 2,
      }),
      retrievalRow({
        scenario_id: "toolret-1",
        target_pool_size: 100,
        recall_at_k: 0.5,
        reciprocal_rank: 0.5,
        hit_at_k: true,
      }),
    ];
    const md = renderReport({ cells: [], retrieval, generatedAt: new Date("2026-05-01") });
    expect(md).toContain("### metatool / single-tool");
    expect(md).toContain("### metatool / multi-tool");
    expect(md).toContain("### toolret / single-tool");
    expect(md).toContain("median recall@K");
    expect(md).toContain("median nDCG@K");
    expect(md).toContain("| K |");
  });
});
