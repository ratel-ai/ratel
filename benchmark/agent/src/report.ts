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

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface ArmModelStats {
  arm: Arm;
  model: string;
  /**
   * Pool size this row aggregates; sweeps emit one row per (arm, model, pool_size).
   * `null` for pool-size-agnostic arms (e.g. `control-oracle`) — exactly one row
   * per (arm, model) regardless of `--pool-sizes`.
   */
  pool_size: number | null;
  /** Distinct scenarios contributing to this group. */
  scenarios: number;
  /** Total cells (= scenarios × runs_per_scenario_for_this_group). */
  n: number;
  /** Mean across per-scenario success rates (passes / runs, averaged across scenarios). */
  success_rate: number;
  /**
   * Mean catalog (= tools the agent actually saw) size across cells. Counts
   * direct tools AND gateway tools (`search_tools` / `invoke_tool`) — the
   * honest "what was visible" tally. For oracle this is the gold count
   * (~1–2); for control-baseline it equals `pool_size`; for ratel arms it's
   * direct + 2 gateway tools (so ~5–7 at top-K=5).
   */
  mean_catalog_size: number;
  mean_input_tokens: number;
  mean_total_tokens: number;
  mean_turns: number;
  mean_dollar_cost: number;
  mean_wall_ms: number;
}

interface ScenarioStats {
  arm: Arm;
  model: string;
  pool_size: number | null;
  scenario_id: string;
  /** Passes / runs for this scenario in this (arm, model, pool_size). */
  success_rate: number;
  mean_catalog: number;
  mean_input: number;
  mean_total: number;
  mean_turns: number;
  mean_dollar: number;
  mean_wall: number;
  /** Number of runs aggregated for this scenario. */
  runs: number;
}

/**
 * Two-stage aggregation: cells → per-scenario means → per-(arm, model, pool_size)
 * means.
 *
 * Pool size is part of the grouping key so a sweep (`--pool-sizes 30,50,180`)
 * emits one row per pool size instead of collapsing them into a single row
 * whose averages mix populations. Scenarios whose `candidate_pool` is smaller
 * than the requested pool size end up with the same actual `pool_size`
 * (universe ceiling) and dedupe naturally.
 *
 * The per-scenario stage gives every scenario equal weight in the headline,
 * so a high-run-count scenario can't drown out the rest. Concretely: a
 * scenario that passes 4/5 runs contributes a 0.8 success rate, regardless
 * of how many other scenarios ran 1× or 10×. This is the natural reading
 * of "what fraction of scenarios succeed" when runs-per-scenario varies.
 */
export function statsByArmModel(cells: CellResult[]): ArmModelStats[] {
  // Stage 1: per (scenario, arm, model, pool_size) → per-scenario means.
  const byScenario = new Map<string, CellResult[]>();
  for (const c of cells) {
    const key = `${c.scenario_id}::${c.arm}::${c.model}::${c.pool_size}`;
    const arr = byScenario.get(key) ?? [];
    arr.push(c);
    byScenario.set(key, arr);
  }
  const perScenario: ScenarioStats[] = [];
  for (const arr of byScenario.values()) {
    const head = arr[0];
    const passes = arr.filter(
      (c) => c.programmatic_verdict === "pass" || c.judge_verdict === "pass",
    ).length;
    perScenario.push({
      arm: head.arm,
      model: head.model,
      pool_size: head.pool_size,
      scenario_id: head.scenario_id,
      success_rate: passes / arr.length,
      mean_catalog: mean(arr.map((c) => c.catalog_size)),
      mean_input: mean(arr.map((c) => c.input_tokens)),
      mean_total: mean(arr.map((c) => c.total_tokens)),
      mean_turns: mean(arr.map((c) => c.turns)),
      mean_dollar: mean(arr.map((c) => c.dollar_cost)),
      mean_wall: mean(arr.map((c) => c.wall_ms)),
      runs: arr.length,
    });
  }

  // Stage 2: per (arm, model, pool_size) → mean across per-scenario means.
  const byGroup = new Map<string, ScenarioStats[]>();
  for (const p of perScenario) {
    const key = `${p.arm}::${p.model}::${p.pool_size}`;
    const arr = byGroup.get(key) ?? [];
    arr.push(p);
    byGroup.set(key, arr);
  }
  const out: ArmModelStats[] = [];
  for (const ps of byGroup.values()) {
    const head = ps[0];
    out.push({
      arm: head.arm,
      model: head.model,
      pool_size: head.pool_size,
      scenarios: ps.length,
      n: ps.reduce((acc, p) => acc + p.runs, 0),
      success_rate: mean(ps.map((p) => p.success_rate)),
      mean_catalog_size: mean(ps.map((p) => p.mean_catalog)),
      mean_input_tokens: mean(ps.map((p) => p.mean_input)),
      mean_total_tokens: mean(ps.map((p) => p.mean_total)),
      mean_turns: mean(ps.map((p) => p.mean_turns)),
      mean_dollar_cost: mean(ps.map((p) => p.mean_dollar)),
      mean_wall_ms: mean(ps.map((p) => p.mean_wall)),
    });
  }
  return out.sort(
    (a, b) =>
      a.model.localeCompare(b.model) ||
      a.arm.localeCompare(b.arm) ||
      comparePoolSizes(a.pool_size, b.pool_size),
  );
}

/** Sort comparator that puts agnostic rows (`null`) after every numeric pool size. */
function comparePoolSizes(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export interface SavingsRow {
  model: string;
  pool_size: number;
  control_mean_input: number;
  ratel_mean_input: number;
  oracle_mean_input: number;
  input_savings_pct: number;
  control_mean_total: number;
  ratel_mean_total: number;
  total_savings_pct: number;
  control_mean_dollars: number;
  ratel_mean_dollars: number;
  dollar_savings_pct: number;
  control_mean_turns: number;
  ratel_mean_turns: number;
  oracle_mean_turns: number;
  control_mean_wall_ms: number;
  ratel_mean_wall_ms: number;
  wall_savings_pct: number;
}

function pctSavings(control: number, ratel: number): number {
  if (control === 0) return 0;
  return (1 - ratel / control) * 100;
}

/**
 * Pair control-baseline vs ratel-full within each (model, pool_size). Sweeps
 * land one row per pool size so each pool's savings story stays intact —
 * collapsing across pool sizes would dilute small-pool wins with large-pool
 * losses (or vice versa). Oracle is pool-size-agnostic (one row per model),
 * so its tokens/turns are joined per-model and shown identically across all
 * pool rows for that model.
 */
export function savingsByModel(cells: CellResult[]): SavingsRow[] {
  const stats = statsByArmModel(cells);
  const oracleByModel = new Map<string, ArmModelStats>();
  for (const s of stats) {
    if (s.arm === "control-oracle") oracleByModel.set(s.model, s);
  }
  // Skip oracle (and any other agnostic arm) when grouping for the per-pool
  // pairing — its `pool_size` is `null` and would never pair with control/ratel
  // rows anyway.
  const byGroup = new Map<string, ArmModelStats[]>();
  for (const s of stats) {
    if (s.pool_size === null) continue;
    const key = `${s.model}::${s.pool_size}`;
    const arr = byGroup.get(key) ?? [];
    arr.push(s);
    byGroup.set(key, arr);
  }
  const out: SavingsRow[] = [];
  for (const arr of byGroup.values()) {
    const control = arr.find((s) => s.arm === "control-baseline");
    const ratel = arr.find((s) => s.arm === "ratel-full");
    if (!control || !ratel || control.pool_size === null) continue;
    const oracle = oracleByModel.get(control.model);
    out.push({
      model: control.model,
      pool_size: control.pool_size,
      control_mean_input: control.mean_input_tokens,
      ratel_mean_input: ratel.mean_input_tokens,
      oracle_mean_input: oracle?.mean_input_tokens ?? 0,
      input_savings_pct: pctSavings(control.mean_input_tokens, ratel.mean_input_tokens),
      control_mean_total: control.mean_total_tokens,
      ratel_mean_total: ratel.mean_total_tokens,
      total_savings_pct: pctSavings(control.mean_total_tokens, ratel.mean_total_tokens),
      control_mean_dollars: control.mean_dollar_cost,
      ratel_mean_dollars: ratel.mean_dollar_cost,
      dollar_savings_pct: pctSavings(control.mean_dollar_cost, ratel.mean_dollar_cost),
      control_mean_turns: control.mean_turns,
      ratel_mean_turns: ratel.mean_turns,
      oracle_mean_turns: oracle?.mean_turns ?? 0,
      control_mean_wall_ms: control.mean_wall_ms,
      ratel_mean_wall_ms: ratel.mean_wall_ms,
      wall_savings_pct: pctSavings(control.mean_wall_ms, ratel.mean_wall_ms),
    });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || a.pool_size - b.pool_size);
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
  pool_size: number | null;
  pass: number;
  fail: number;
  errored: number;
  missing_gold: number;
  step_limit: number;
}

export function failureTaxonomy(cells: CellResult[]): FailureCounts[] {
  const groups = new Map<string, CellResult[]>();
  for (const c of cells) {
    const key = `${c.arm}::${c.model}::${c.pool_size}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  const out: FailureCounts[] = [];
  for (const arr of groups.values()) {
    const head = arr[0];
    out.push({
      arm: head.arm,
      model: head.model,
      pool_size: head.pool_size,
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
  return out.sort(
    (a, b) =>
      a.model.localeCompare(b.model) ||
      a.arm.localeCompare(b.arm) ||
      comparePoolSizes(a.pool_size, b.pool_size),
  );
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

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtPoolSize(p: number | null): string {
  return p === null ? "—" : String(p);
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

  // 1. Headline. Numbers are mean-of-per-scenario-means: every scenario weighs
  // the same in the headline regardless of how many runs it has. `pool` is the
  // BM25 universe (= what the agent had to pick from); `catalog` is what the
  // model actually saw, gateway tools included — for sweep arms it equals
  // `pool`, for oracle pool is "—" and catalog reveals the gold-tool count
  // (~1–2), for ratel arms it's direct top-K plus the 2 gateway tools.
  lines.push("## Headline");
  lines.push("");
  lines.push(
    "| arm | model | pool | catalog | scenarios | n | success | mean input | mean total | mean turns | mean $ | mean wall |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of stats) {
    lines.push(
      `| ${s.arm} | ${s.model} | ${fmtPoolSize(s.pool_size)} | ${fmtNum(s.mean_catalog_size)} | ${s.scenarios} | ${s.n} | ${fmtPct(s.success_rate * 100)} | ${fmtNum(s.mean_input_tokens)} | ${fmtNum(s.mean_total_tokens)} | ${fmtNum(s.mean_turns)} | ${fmtDollars(s.mean_dollar_cost)} | ${fmtSeconds(s.mean_wall_ms)} |`,
    );
  }
  lines.push("");

  // 2. Token + wall savings
  lines.push("## Token savings (ratel vs control)");
  lines.push("");
  if (savings.length === 0) {
    lines.push("_No control + ratel pairs in this run._");
  } else {
    lines.push(
      "| model | pool | input (ctrl → ratel) | input savings | total (ctrl → ratel) | total savings | $ (ctrl → ratel) | $ savings | wall (ctrl → ratel) | wall savings | oracle input | turns Δ |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const s of savings) {
      const turnsDelta = s.ratel_mean_turns - s.control_mean_turns;
      lines.push(
        `| ${s.model} | ${s.pool_size} | ${fmtNum(s.control_mean_input)} → ${fmtNum(s.ratel_mean_input)} | **${fmtPct(s.input_savings_pct)}** | ${fmtNum(s.control_mean_total)} → ${fmtNum(s.ratel_mean_total)} | **${fmtPct(s.total_savings_pct)}** | ${fmtDollars(s.control_mean_dollars)} → ${fmtDollars(s.ratel_mean_dollars)} | **${fmtPct(s.dollar_savings_pct)}** | ${fmtSeconds(s.control_mean_wall_ms)} → ${fmtSeconds(s.ratel_mean_wall_ms)} | **${fmtPct(s.wall_savings_pct)}** | ${fmtNum(s.oracle_mean_input)} | ${turnsDelta >= 0 ? "+" : ""}${fmtNum(turnsDelta)} |`,
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
  lines.push("| arm | model | pool | pass | fail | errored | missing gold | step-limit |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const f of failures) {
    lines.push(
      `| ${f.arm} | ${f.model} | ${fmtPoolSize(f.pool_size)} | ${f.pass} | ${f.fail} | ${f.errored} | ${f.missing_gold} | ${f.step_limit} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}
