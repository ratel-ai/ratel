import type { BenchmarkRunResult, ScenarioResult } from "./types.js";

export interface RunSummary {
  agent: string;
  model: string;
  overall: CategorySummary;
  byCategory: Record<string, CategorySummary>;
}

export interface CategorySummary {
  [scorer: string]: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalOutputReasoningTokens: number;
  totalDurationMs: number;
  totalCost: number;
}

function summarizeCategory(scenarios: ScenarioResult[]): CategorySummary {
  if (scenarios.length === 0) return { totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0, totalOutputReasoningTokens: 0, totalDurationMs: 0, totalCost: 0 };

  const scorerNames = new Set<string>();
  for (const s of scenarios) {
    for (const name of Object.keys(s.scores)) scorerNames.add(name);
  }

  const totalInput = scenarios.reduce((sum, s) => sum + s.inputTokens, 0);
  const totalCached = scenarios.reduce((sum, s) => sum + (s.cachedInputTokens ?? 0), 0);
  const totalOutput = scenarios.reduce((sum, s) => sum + s.outputTokens, 0);
  const totalReasoning = scenarios.reduce((sum, s) => sum + (s.outputReasoningTokens ?? 0), 0);

  const summary: CategorySummary = {
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCachedInputTokens: totalCached,
    totalOutputReasoningTokens: totalReasoning,
    totalDurationMs: scenarios.reduce((sum, s) => sum + s.durationMs, 0),
    totalCost: scenarios.reduce((sum, s) => sum + s.cost, 0),
  };

  for (const name of scorerNames) {
    summary[name] = scenarios.reduce((sum, s) => sum + (s.scores[name] ?? 0), 0) / scenarios.length;
  }

  return summary;
}

export function summarizeRun(run: BenchmarkRunResult): RunSummary {
  const categories = new Map<string, ScenarioResult[]>();
  for (const s of run.scenarios) {
    const cat = s.category;
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(s);
  }

  const byCategory: Record<string, CategorySummary> = {};
  for (const [cat, scenarios] of categories) {
    byCategory[cat] = summarizeCategory(scenarios);
  }

  return {
    agent: run.agent,
    model: run.model,
    overall: summarizeCategory(run.scenarios),
    byCategory,
  };
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function fmtInt(n: number): string {
  return Math.round(n).toString();
}

function fmtCost(n: number): string {
  return n.toFixed(4);
}

const SCORE_COLS = ["Tool F1", "Tool Precision", "Tool Recall", "Task Correctness", "Negative Correctness", "Hydration Recall"];
const METRIC_COLS = ["Input Tokens", "Cached In", "Output Tokens", "Reasoning Tokens", "Duration (ms)", "Cost ($)"];

function renderSummaryRow(agent: string, summary: CategorySummary): string {
  const vals = [
    agent,
    ...SCORE_COLS.map((c) => fmt(summary[c] ?? 0)),
    fmtInt(summary.totalInputTokens),
    fmtInt(summary.totalCachedInputTokens),
    fmtInt(summary.totalOutputTokens),
    fmtInt(summary.totalOutputReasoningTokens),
    fmtInt(summary.totalDurationMs),
    fmtCost(summary.totalCost),
  ];
  return `| ${vals.join(" | ")} |`;
}

function renderTableHeader(): string[] {
  const header = ["Agent", ...SCORE_COLS, ...METRIC_COLS];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
}

export function generateComparisonReport(runs: BenchmarkRunResult[]): string {
  const summaries = runs.map(summarizeRun);
  const lines: string[] = [];

  lines.push("# Benchmark Comparison\n");
  lines.push(`Generated: ${new Date().toISOString()}\n`);

  // Overall summary table
  lines.push("## Overall\n");
  lines.push(...renderTableHeader());
  for (const s of summaries) {
    lines.push(renderSummaryRow(`${s.agent} (${s.model})`, s.overall));
  }
  lines.push("");

  // Per-category tables
  const allCategories = new Set<string>();
  for (const s of summaries) {
    for (const cat of Object.keys(s.byCategory)) allCategories.add(cat);
  }

  lines.push("## By Category\n");
  for (const cat of [...allCategories].sort()) {
    lines.push(`### ${cat}\n`);
    lines.push(...renderTableHeader());
    for (const s of summaries) {
      const catSummary = s.byCategory[cat];
      if (!catSummary) continue;
      lines.push(renderSummaryRow(`${s.agent} (${s.model})`, catSummary));
    }
    lines.push("");
  }

  // Per-scenario detail table
  lines.push("## Per Scenario\n");
  const label = (s: RunSummary) => `${s.agent} (${s.model})`;
  const scenarioHeader = ["Scenario", "Category", ...summaries.flatMap((s) => [`${label(s)} F1`, `${label(s)} TC`, `${label(s)} HR`])];
  lines.push(`| ${scenarioHeader.join(" | ")} |`);
  lines.push(`| ${scenarioHeader.map(() => "---").join(" | ")} |`);

  const scenarioIds = new Set<number>();
  for (const run of runs) {
    for (const s of run.scenarios) scenarioIds.add(s.scenarioId);
  }

  for (const id of [...scenarioIds].sort((a, b) => a - b)) {
    const scenarioData = runs.map((run) => run.scenarios.find((s) => s.scenarioId === id));
    const first = scenarioData.find(Boolean);
    if (!first) continue;

    const vals = [
      `#${id}`,
      first.category,
      ...scenarioData.flatMap((s) => [
        fmt(s?.scores["Tool F1"] ?? 0),
        fmt(s?.scores["Task Correctness"] ?? 0),
        fmt(s?.scores["Hydration Recall"] ?? 0),
      ]),
    ];
    lines.push(`| ${vals.join(" | ")} |`);
  }
  lines.push("");

  return lines.join("\n");
}
