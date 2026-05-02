// Aggregator. Joins agent.jsonl (cells from runs) with retrieval.jsonl (BM25
// metrics from the Rust layer) and emits REPORT.md.
//
// Pure functions on parsed JSONL — no I/O — so the report logic stays
// testable. The CLI wrapper (`report-cli.ts`) handles file reads/writes.

import type { Arm, CellResult } from "./types.js";

export interface RetrievalRow {
  scenario_id: string;
  target_pool_size: number;
  actual_pool_size: number;
  k: number;
  pool_size: number;
  gold_count: number;
  recall_at_k: number;
  precision_at_k: number;
  reciprocal_rank: number;
  hit_at_k: boolean;
  ndcg_at_k: number;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface ArmModelStats {
  arm: Arm;
  model: string;
  /** Distinct `pool_size` values seen in this group; multiple values mean the campaign mixed pool sizes. */
  pool_sizes: number[];
  n: number;
  success_rate: number;
  median_input_tokens: number;
  median_total_tokens: number;
  median_turns: number;
  median_dollar_cost: number;
  p90_input_tokens: number;
  p90_total_tokens: number;
  variance_ratio: number;
}

export function statsByArmModel(cells: CellResult[]): ArmModelStats[] {
  const groups = new Map<string, CellResult[]>();
  for (const c of cells) {
    const key = `${c.arm}::${c.model}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  const out: ArmModelStats[] = [];
  for (const [key, arr] of groups) {
    const [arm, model] = key.split("::") as [Arm, string];
    const passed = arr.filter(
      (c) => c.programmatic_verdict === "pass" || c.judge_verdict === "pass",
    ).length;
    const inputs = arr.map((c) => c.input_tokens);
    const totals = arr.map((c) => c.total_tokens);
    const turns = arr.map((c) => c.turns);
    const costs = arr.map((c) => c.dollar_cost);
    const poolSizes = [...new Set(arr.map((c) => c.pool_size))].sort((a, b) => a - b);
    const med = median(inputs);
    out.push({
      arm,
      model,
      pool_sizes: poolSizes,
      n: arr.length,
      success_rate: arr.length === 0 ? 0 : passed / arr.length,
      median_input_tokens: med,
      median_total_tokens: median(totals),
      median_turns: median(turns),
      median_dollar_cost: median(costs),
      p90_input_tokens: percentile(inputs, 90),
      p90_total_tokens: percentile(totals, 90),
      variance_ratio: med === 0 ? 0 : percentile(inputs, 90) / med,
    });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || a.arm.localeCompare(b.arm));
}

export interface SavingsRow {
  model: string;
  control_median_input: number;
  hybrid_median_input: number;
  oracle_median_input: number;
  input_savings_pct: number;
  control_median_total: number;
  hybrid_median_total: number;
  total_savings_pct: number;
  control_median_dollars: number;
  hybrid_median_dollars: number;
  dollar_savings_pct: number;
  control_median_turns: number;
  hybrid_median_turns: number;
  oracle_median_turns: number;
}

function pctSavings(control: number, hybrid: number): number {
  if (control === 0) return 0;
  return (1 - hybrid / control) * 100;
}

export function savingsByModel(cells: CellResult[]): SavingsRow[] {
  const stats = statsByArmModel(cells);
  const byModel = new Map<string, ArmModelStats[]>();
  for (const s of stats) {
    const arr = byModel.get(s.model) ?? [];
    arr.push(s);
    byModel.set(s.model, arr);
  }
  const out: SavingsRow[] = [];
  for (const [model, arr] of byModel) {
    const control = arr.find((s) => s.arm === "control");
    const hybrid = arr.find((s) => s.arm === "hybrid");
    const oracle = arr.find((s) => s.arm === "oracle");
    if (!control || !hybrid) continue;
    out.push({
      model,
      control_median_input: control.median_input_tokens,
      hybrid_median_input: hybrid.median_input_tokens,
      oracle_median_input: oracle?.median_input_tokens ?? 0,
      input_savings_pct: pctSavings(control.median_input_tokens, hybrid.median_input_tokens),
      control_median_total: control.median_total_tokens,
      hybrid_median_total: hybrid.median_total_tokens,
      total_savings_pct: pctSavings(control.median_total_tokens, hybrid.median_total_tokens),
      control_median_dollars: control.median_dollar_cost,
      hybrid_median_dollars: hybrid.median_dollar_cost,
      dollar_savings_pct: pctSavings(control.median_dollar_cost, hybrid.median_dollar_cost),
      control_median_turns: control.median_turns,
      hybrid_median_turns: hybrid.median_turns,
      oracle_median_turns: oracle?.median_turns ?? 0,
    });
  }
  return out;
}

export type RetrievalSubset = "single-tool" | "multi-tool";

export interface RetrievalSummary {
  corpus: string;
  subset: RetrievalSubset;
  k: number;
  pool_size: number;
  n: number;
  mean_recall: number;
  median_recall: number;
  mean_mrr: number;
  median_mrr: number;
  mean_ndcg: number;
  median_ndcg: number;
  hit_rate: number;
}

/**
 * Infer a corpus label from a scenario id. The retrieval JSONL doesn't carry a
 * corpus tag of its own — the ingestion adapters prefix scenario ids per source
 * (`metatool-st-*` / `metatool-mt-*`, `toolret-*`, ...), and the report groups
 * by that prefix so multi-corpus runs render one table per source.
 */
export function corpusOf(scenarioId: string): string {
  if (scenarioId.startsWith("metatool-")) return "metatool";
  if (scenarioId.startsWith("toolret-")) return "toolret";
  return "other";
}

/**
 * Bucket a row by gold-set size. Single-tool rows have binary recall (0 or 1),
 * which is mathematically the hit rate; multi-tool rows produce fractional
 * recall and are interpreted differently (e.g. "do both gold tools land in
 * top-K"). We surface them in separate panels so neither story drowns the
 * other.
 */
export function subsetOf(goldCount: number): RetrievalSubset {
  return goldCount > 1 ? "multi-tool" : "single-tool";
}

export function retrievalByPoolSize(rows: RetrievalRow[]): RetrievalSummary[] {
  const groups = new Map<string, RetrievalRow[]>();
  for (const r of rows) {
    const key = `${corpusOf(r.scenario_id)}::${subsetOf(r.gold_count)}::${r.k}::${r.target_pool_size}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const out: RetrievalSummary[] = [];
  for (const [key, arr] of groups) {
    const [corpus, subset, kStr, poolStr] = key.split("::") as [
      string,
      RetrievalSubset,
      string,
      string,
    ];
    const recalls = arr.map((r) => r.recall_at_k);
    const mrrs = arr.map((r) => r.reciprocal_rank);
    const ndcgs = arr.map((r) => r.ndcg_at_k);
    out.push({
      corpus,
      subset,
      k: Number(kStr),
      pool_size: Number(poolStr),
      n: arr.length,
      mean_recall: mean(recalls),
      median_recall: median(recalls),
      mean_mrr: mean(mrrs),
      median_mrr: median(mrrs),
      mean_ndcg: mean(ndcgs),
      median_ndcg: median(ndcgs),
      hit_rate: mean(arr.map((r) => (r.hit_at_k ? 1 : 0))),
    });
  }
  return out.sort(
    (a, b) =>
      a.corpus.localeCompare(b.corpus) ||
      a.subset.localeCompare(b.subset) ||
      a.k - b.k ||
      a.pool_size - b.pool_size,
  );
}

export interface FailureCounts {
  arm: Arm;
  model: string;
  pass: number;
  fail: number;
  errored: number;
  missing_gold: number;
  step_limit: number;
}

export function failureTaxonomy(cells: CellResult[]): FailureCounts[] {
  const groups = new Map<string, CellResult[]>();
  for (const c of cells) {
    const key = `${c.arm}::${c.model}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  const out: FailureCounts[] = [];
  for (const [key, arr] of groups) {
    const [arm, model] = key.split("::") as [Arm, string];
    out.push({
      arm,
      model,
      pass: arr.filter((c) => c.programmatic_verdict === "pass").length,
      fail: arr.filter((c) => c.programmatic_verdict === "fail").length,
      errored: arr.filter((c) => c.error !== null).length,
      missing_gold: arr.filter((c) => c.programmatic_verdict === "fail" && c.tool_calls.length > 0)
        .length,
      step_limit: arr.filter(
        (c) => c.finish_reason === "max-steps" || c.finish_reason === "tool-calls",
      ).length,
    });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || a.arm.localeCompare(b.arm));
}

function fmtPct(x: number): string {
  return `${x.toFixed(1)}%`;
}

function fmtNum(x: number): string {
  if (x >= 1000) return x.toFixed(0);
  if (x >= 10) return x.toFixed(1);
  return x.toFixed(3);
}

function fmtDollars(x: number): string {
  return `$${x.toFixed(4)}`;
}

export function renderReport(args: {
  cells: CellResult[];
  retrieval: RetrievalRow[];
  generatedAt?: Date;
}): string {
  const date = (args.generatedAt ?? new Date()).toISOString();
  const stats = statsByArmModel(args.cells);
  const savings = savingsByModel(args.cells);
  const retrieval = retrievalByPoolSize(args.retrieval);
  const failures = failureTaxonomy(args.cells);

  const lines: string[] = [];
  lines.push("# Ratel benchmark report");
  lines.push("");
  lines.push(`_Generated: ${date}_`);
  lines.push("");
  lines.push(`Cells: **${args.cells.length}**, retrieval rows: **${args.retrieval.length}**.`);
  lines.push("");

  // 1. Headline
  lines.push("## Headline");
  lines.push("");
  lines.push(
    "| arm | model | pool | n | success | median input | median total | median turns | median $ | p90/median input |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const s of stats) {
    const pool = s.pool_sizes.length === 0 ? "—" : s.pool_sizes.join(",");
    lines.push(
      `| ${s.arm} | ${s.model} | ${pool} | ${s.n} | ${fmtPct(s.success_rate * 100)} | ${fmtNum(s.median_input_tokens)} | ${fmtNum(s.median_total_tokens)} | ${fmtNum(s.median_turns)} | ${fmtDollars(s.median_dollar_cost)} | ${s.variance_ratio.toFixed(2)}× |`,
    );
  }
  lines.push("");

  // 2. Token savings
  lines.push("## Token savings (hybrid vs control)");
  lines.push("");
  if (savings.length === 0) {
    lines.push("_No control + hybrid pairs in this run._");
  } else {
    lines.push(
      "| model | input (ctrl → hyb) | input savings | total (ctrl → hyb) | total savings | $ (ctrl → hyb) | $ savings | oracle input | turns Δ |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const s of savings) {
      const turnsDelta = s.hybrid_median_turns - s.control_median_turns;
      lines.push(
        `| ${s.model} | ${fmtNum(s.control_median_input)} → ${fmtNum(s.hybrid_median_input)} | **${fmtPct(s.input_savings_pct)}** | ${fmtNum(s.control_median_total)} → ${fmtNum(s.hybrid_median_total)} | **${fmtPct(s.total_savings_pct)}** | ${fmtDollars(s.control_median_dollars)} → ${fmtDollars(s.hybrid_median_dollars)} | **${fmtPct(s.dollar_savings_pct)}** | ${fmtNum(s.oracle_median_input)} | ${turnsDelta >= 0 ? "+" : ""}${fmtNum(turnsDelta)} |`,
      );
    }
  }
  lines.push("");

  // 3. Retrieval quality. One panel per (corpus, gold-set bucket); inside the
  // panel rows are sorted by (k, pool_size). Single-tool and multi-tool live in
  // different panels because their recall semantics differ (binary vs fractional).
  lines.push("## Retrieval quality (BM25, no LLM)");
  lines.push("");
  if (retrieval.length === 0) {
    lines.push(
      "_No retrieval rows; run `cargo run -p ratel-benchmark -- retrieval ...` to populate._",
    );
  } else {
    const panels = new Map<string, RetrievalSummary[]>();
    for (const r of retrieval) {
      const key = `${r.corpus}::${r.subset}`;
      const arr = panels.get(key) ?? [];
      arr.push(r);
      panels.set(key, arr);
    }
    for (const [key, summaries] of panels) {
      const [corpus, subset] = key.split("::");
      lines.push(`### ${corpus} / ${subset}`);
      lines.push("");
      lines.push(
        "| K | pool size | n | hit@K | mean recall@K | median recall@K | mean MRR@K | median MRR@K | mean nDCG@K | median nDCG@K |",
      );
      lines.push("|---|---|---|---|---|---|---|---|---|---|");
      for (const r of summaries) {
        lines.push(
          `| ${r.k} | ${r.pool_size} | ${r.n} | ${fmtPct(r.hit_rate * 100)} | ${r.mean_recall.toFixed(3)} | ${r.median_recall.toFixed(3)} | ${r.mean_mrr.toFixed(3)} | ${r.median_mrr.toFixed(3)} | ${r.mean_ndcg.toFixed(3)} | ${r.median_ndcg.toFixed(3)} |`,
        );
      }
      lines.push("");
    }
  }

  // 4. Failure taxonomy
  lines.push("## Failure taxonomy");
  lines.push("");
  lines.push("| arm | model | pass | fail | errored | missing gold | step-limit |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const f of failures) {
    lines.push(
      `| ${f.arm} | ${f.model} | ${f.pass} | ${f.fail} | ${f.errored} | ${f.missing_gold} | ${f.step_limit} |`,
    );
  }
  lines.push("");

  // 5. Variance flags. Skip `control`: its variance is expected (token use scales
  // with how many tools were dumped in × how long the agent flailed) and is not
  // a finding. Hybrid/oracle are where consistency is part of the claim.
  const flagged = stats.filter((s) => s.arm !== "control" && s.variance_ratio > 1.5);
  lines.push("## Variance flags (hybrid / oracle, p90/median > 1.5)");
  lines.push("");
  if (flagged.length === 0) {
    lines.push("_No high-variance cells in hybrid / oracle._");
  } else {
    for (const s of flagged) {
      lines.push(
        `- **${s.arm} / ${s.model}**: p90/median = ${s.variance_ratio.toFixed(2)}× — investigate scenario-level outliers.`,
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}
