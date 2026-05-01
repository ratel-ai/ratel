import { describe, expect, it } from "vitest";
import {
  corpusOf,
  failureTaxonomy,
  mean,
  median,
  percentile,
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
    arm: "control" as Arm,
    model: "gpt-5.4-mini",
    run_index: 0,
    catalog_size: 5,
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

  it("percentile is order-statistic at floor(p%/100 * len)", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(10);
  });

  it("mean returns 0 for empty", () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
  });
});

describe("statsByArmModel", () => {
  it("groups by (arm, model) and computes medians + success rate", () => {
    const cells = [
      cell({ arm: "control", input_tokens: 1000 }),
      cell({ arm: "control", input_tokens: 1500, programmatic_verdict: "fail" }),
      cell({ arm: "hybrid", input_tokens: 200 }),
      cell({ arm: "hybrid", input_tokens: 300 }),
    ];
    const stats = statsByArmModel(cells);
    expect(stats).toHaveLength(2);
    const control = stats.find((s) => s.arm === "control");
    const hybrid = stats.find((s) => s.arm === "hybrid");
    expect(control?.n).toBe(2);
    expect(control?.success_rate).toBe(0.5);
    expect(control?.median_input_tokens).toBe(1250);
    expect(hybrid?.median_input_tokens).toBe(250);
    expect(hybrid?.success_rate).toBe(1);
  });
});

describe("savingsByModel", () => {
  it("computes hybrid vs control savings % across input, total, and $", () => {
    const cells = [
      cell({ arm: "control", input_tokens: 1000, total_tokens: 1200, dollar_cost: 0.01 }),
      cell({ arm: "hybrid", input_tokens: 250, total_tokens: 400, dollar_cost: 0.003 }),
      cell({ arm: "oracle", input_tokens: 100, total_tokens: 200, dollar_cost: 0.001 }),
    ];
    const [s] = savingsByModel(cells);
    expect(s.control_median_input).toBe(1000);
    expect(s.hybrid_median_input).toBe(250);
    expect(s.input_savings_pct).toBeCloseTo(75, 5);
    expect(s.control_median_total).toBe(1200);
    expect(s.hybrid_median_total).toBe(400);
    expect(s.total_savings_pct).toBeCloseTo((1 - 400 / 1200) * 100, 5);
    expect(s.control_median_dollars).toBeCloseTo(0.01, 5);
    expect(s.hybrid_median_dollars).toBeCloseTo(0.003, 5);
    expect(s.dollar_savings_pct).toBeCloseTo(70, 5);
    expect(s.oracle_median_input).toBe(100);
  });

  it("skips models without both control and hybrid arms", () => {
    const cells = [cell({ arm: "control" })];
    expect(savingsByModel(cells)).toHaveLength(0);
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
      cell({ arm: "control", programmatic_verdict: "pass" }),
      cell({
        arm: "control",
        programmatic_verdict: "fail",
        tool_calls: [{ toolId: "wrong", args: {} }],
      }),
      cell({ arm: "control", programmatic_verdict: "fail", error: "timeout" }),
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
      cell({ arm: "control", input_tokens: 1000, total_tokens: 1200, dollar_cost: 0.01 }),
      cell({ arm: "hybrid", input_tokens: 250, total_tokens: 400, dollar_cost: 0.003 }),
      cell({ arm: "oracle", input_tokens: 100, total_tokens: 200, dollar_cost: 0.001 }),
    ];
    const md = renderReport({ cells, retrieval: [], generatedAt: new Date("2026-05-01") });
    expect(md).toContain("# Ratel benchmark report");
    expect(md).toContain("## Headline");
    expect(md).toContain("## Token savings");
    expect(md).toContain("## Retrieval quality");
    expect(md).toContain("## Failure taxonomy");
    expect(md).toContain("## Variance flags");
    expect(md).toContain("**75.0%**"); // input savings
    expect(md).toContain("**70.0%**"); // dollar savings
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

  it("omits control from the variance-flag panel even when control is high-variance", () => {
    // Control with two wildly different runs → p90/median > 1.5×; hybrid is steady.
    const cells = [
      cell({ arm: "control", input_tokens: 1000, run_index: 0 }),
      cell({ arm: "control", input_tokens: 5000, run_index: 1 }),
      cell({ arm: "hybrid", input_tokens: 250, run_index: 0 }),
      cell({ arm: "hybrid", input_tokens: 260, run_index: 1 }),
    ];
    const md = renderReport({ cells, retrieval: [], generatedAt: new Date("2026-05-01") });
    expect(md).toContain("## Variance flags (hybrid / oracle, p90/median > 1.5)");
    expect(md).toContain("_No high-variance cells in hybrid / oracle._");
    expect(md).not.toMatch(/\*\*control \//);
  });
});
