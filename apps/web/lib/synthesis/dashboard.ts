import type { CategorySplits, ToolsByName } from "@/lib/ingest/categorize";
import {
  CATEGORY_META,
  CHART_CATEGORIES,
  type ChartCategory,
  CONTEXT_SOURCES,
  type ContextSource,
  SOURCE_META,
} from "@/lib/ingest/context";
import type { DailyAggregateRow } from "@/lib/ingest/otlp/queries";
import { fmtCost, fmtCount } from "@/lib/platform/format";

// Re-exported so existing dashboard-component imports keep working; the
// implementations moved to the shared lib/format.ts.
export { fmtCost, fmtCount };

/**
 * Pure transforms from raw daily aggregates to the dashboard view model. Tokens
 * are real per-source sums. Cost and latency are not natively per-source, so each
 * day's total is distributed across sources in proportion to that day's token
 * split — a defensible approximation (cost/time scale with context size).
 */

export type Metric = "tokens" | "latency" | "cost";

export type SourceValues = Record<ContextSource, number>;

/** Like {@link SourceValues}, but with the tools/history splits broken out. */
export type CategoryValues = Record<ChartCategory, number>;

export type DayBar = {
  /** Short date label (e.g. "Jun 24") for the x-axis. */
  label: string;
  /** Per-category (split-aware) values — what the stacked chart renders. */
  values: CategoryValues;
  total: number;
};

export type MetricView = {
  /** Headline number: total tokens, total cost, or avg latency per run. */
  hero: number;
  bars: DayBar[];
  /** Window totals rolled up to the five sources — for suggestions. */
  bySource: SourceValues;
  /** Window totals per split-aware category — for the legend and table. */
  byCategory: CategoryValues;
  total: number;
};

/** One day on the waste-breakdown timeline (tokens sent, split by waste axis). */
export type BreakdownDay = {
  label: string;
  toolsUsed: number;
  toolsUnused: number;
  historyCached: number;
  historyUncached: number;
};

/**
 * The waste story the ADR-0013 rich logs let us measure directly: how much of the
 * tool footprint the model never called (`unused`), and how much of history the
 * provider had to re-read uncached (`uncached`). Both are the tokens Ratel can
 * reclaim — the "you could save ~N" headline, now derived from real usage rather
 * than an SDK-reported estimate.
 */
export type BreakdownView = {
  /** Per-day timeline — drives the breakdown chart. */
  days: BreakdownDay[];
  toolsUsedTotal: number;
  toolsUnusedTotal: number;
  historyCachedTotal: number;
  historyUncachedTotal: number;
  /** unused / (used + unused), 0..1 — the share of tool tokens that go uncalled. */
  toolsUnusedRate: number;
  /** uncached / (cached + uncached), 0..1 — the share of history re-read each run. */
  historyUncachedRate: number;
};

export type DashboardModel = {
  runs: number;
  hasData: boolean;
  /** Per-source trend over the window: did this source grow, hold, or shrink? */
  trend: Record<ContextSource, "up" | "flat" | "down">;
  /** Per-category trend — split-aware twin of {@link trend}, for the table. */
  categoryTrend: Record<ChartCategory, "up" | "flat" | "down">;
  /** Daily token series per category — for the table sparklines. */
  categorySeries: Record<ChartCategory, number[]>;
  /** Runs per day, oldest first — the denominator behind per-run KPIs + deltas. */
  runsSeries: number[];
  metrics: Record<Metric, MetricView>;
  /** Where the reclaimable tokens are: unused tools + uncached history. */
  breakdown: BreakdownView;
};

const zero = (): SourceValues => ({
  skills: 0,
  tools: 0,
  history: 0,
  memory: 0,
  user_input: 0,
});

const catZero = (): CategoryValues =>
  Object.fromEntries(CHART_CATEGORIES.map((c) => [c, 0])) as CategoryValues;

/**
 * Divide a run's per-source tokens into split-aware categories, re-scaling the
 * `tools`/`history` totals by the ratio the splits report so each half always
 * sums back to its source (robust to any drift, or missing splits — then the
 * whole source falls to its primary half: all tools "used", all history "cached").
 */
function toCategoryValues(tokens: SourceValues, splits: CategorySplits): CategoryValues {
  const toolsPair = splits.tools_used + splits.tools_unused;
  const usedShare = toolsPair > 0 ? splits.tools_used / toolsPair : 1;
  const histPair = splits.history_cached + splits.history_uncached;
  const cachedShare = histPair > 0 ? splits.history_cached / histPair : 1;
  const toolsUsed = tokens.tools * usedShare;
  const historyCached = tokens.history * cachedShare;
  return {
    skills: tokens.skills,
    tools_used: toolsUsed,
    tools_unused: tokens.tools - toolsUsed,
    history_cached: historyCached,
    history_uncached: tokens.history - historyCached,
    memory: tokens.memory,
    user_input: tokens.user_input,
  };
}

/** Start of the lookback window — `days` ago from now. */
export function windowSince(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/** Last `days` calendar days as YYYY-MM-DD (UTC), oldest first. */
export function lastNDays(days: number): string[] {
  const now = Date.now();
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/* ------------------------------- date ranges ------------------------------ */

export type RangePreset = "7d" | "14d" | "30d" | "3m" | "12m";

/** Selectable presets, in menu order. `label` doubles as the dropdown text. */
export const RANGE_PRESETS: { id: RangePreset; label: string }[] = [
  { id: "7d", label: "Last 7 days" },
  { id: "14d", label: "Last 14 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "3m", label: "Last 3 months" },
  { id: "12m", label: "Last 12 months" },
];

const PRESET_IDS = new Set<string>(RANGE_PRESETS.map((p) => p.id));

/** Upper bound on days in a window — keeps the query and SVG chart bounded. */
const MAX_RANGE_DAYS = 372;

/** A fully-resolved window: bounds for the query, day list for the model, label. */
export type ResolvedRange = {
  preset: RangePreset | "custom";
  /** Inclusive day bounds, YYYY-MM-DD (UTC). */
  from: string;
  to: string;
  /** Lower bound for the events query (start of `from`, UTC). */
  since: Date;
  /** Exclusive upper bound for the events query (start of the day after `to`). */
  until: Date;
  /** Calendar days in the window, oldest first — drives the chart bars. */
  days: string[];
  /** Human label for the hero suffix, e.g. "last 7 days" or "Jun 1 – Jun 24". */
  label: string;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Validate a YYYY-MM-DD string and reject impossible dates (e.g. Feb 31). */
function parseIsoDay(s: string | undefined | null): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

function addDaysIso(isoDay: string, n: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function addMonthsIso(isoDay: string, n: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  const day = d.getUTCDate();
  // Set the day to 1 before shifting the month so a short target month can't
  // overflow (e.g. May 31 −3mo would roll Feb→Mar); then clamp back to the day,
  // capped at the target month's last day.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

/** Inclusive calendar days from `fromIso` to `toIso` (UTC), oldest first. */
export function daysBetween(fromIso: string, toIso: string): string[] {
  if (fromIso > toIso) return daysBetween(toIso, fromIso);
  const out: string[] = [];
  let cur = fromIso;
  while (cur <= toIso) {
    out.push(cur);
    cur = addDaysIso(cur, 1);
  }
  return out;
}

function presetStart(preset: RangePreset, today: string): string {
  switch (preset) {
    case "7d":
      return addDaysIso(today, -6);
    case "14d":
      return addDaysIso(today, -13);
    case "30d":
      return addDaysIso(today, -29);
    case "3m":
      return addDaysIso(addMonthsIso(today, -3), 1);
    case "12m":
      return addDaysIso(addMonthsIso(today, -12), 1);
  }
}

function presetLabel(preset: RangePreset): string {
  return RANGE_PRESETS.find((p) => p.id === preset)!.label.toLowerCase();
}

/**
 * Resolve URL params (`range`, `from`, `to`) into a concrete window. Falls back to
 * the 30-day preset for missing/invalid input; clamps custom windows to
 * `MAX_RANGE_DAYS`. Day boundaries are UTC, matching the daily aggregate buckets.
 */
export function resolveRange(params: {
  range?: string;
  from?: string;
  to?: string;
}): ResolvedRange {
  const today = todayIso();
  const customFrom = parseIsoDay(params.from);
  const customTo = parseIsoDay(params.to);
  const hasCustom = Boolean(customFrom && customTo);

  let preset: RangePreset | "custom";
  let from: string;
  let to: string;

  if ((params.range === "custom" || !params.range) && hasCustom) {
    preset = "custom";
    from = customFrom! <= customTo! ? customFrom! : customTo!;
    to = customFrom! <= customTo! ? customTo! : customFrom!;
  } else if (params.range && PRESET_IDS.has(params.range)) {
    preset = params.range as RangePreset;
    to = today;
    from = presetStart(preset, today);
  } else {
    preset = "30d";
    to = today;
    from = presetStart("30d", today);
  }

  let days = daysBetween(from, to);
  if (days.length > MAX_RANGE_DAYS) {
    from = addDaysIso(to, -(MAX_RANGE_DAYS - 1));
    days = daysBetween(from, to);
  }

  return {
    preset,
    from,
    to,
    since: new Date(`${from}T00:00:00Z`),
    until: new Date(`${addDaysIso(to, 1)}T00:00:00Z`),
    days,
    label: preset === "custom" ? `${dayLabel(from)} – ${dayLabel(to)}` : presetLabel(preset),
  };
}

function dayLabel(isoDay: string): string {
  return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function trendOf(daily: number[]): "up" | "flat" | "down" {
  if (daily.length < 2) return "flat";
  const mid = Math.floor(daily.length / 2);
  const first = daily.slice(0, mid);
  const second = daily.slice(mid);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const a = avg(first);
  const b = avg(second);
  if (a === 0) return b > 0 ? "up" : "flat";
  const change = (b - a) / a;
  if (change > 0.15) return "up";
  if (change < -0.15) return "down";
  return "flat";
}

const emptySeries = (): Record<ContextSource, number[]> => ({
  skills: [],
  tools: [],
  history: [],
  memory: [],
  user_input: [],
});

const emptyCatSeries = (): Record<ChartCategory, number[]> =>
  Object.fromEntries(CHART_CATEGORIES.map((c) => [c, []])) as unknown as Record<
    ChartCategory,
    number[]
  >;

const sumAllCat = (v: CategoryValues) => CHART_CATEGORIES.reduce((s, k) => s + v[k], 0);

/** Roll a per-day breakdown timeline up into totals + the two waste rates. */
function buildBreakdownView(days: BreakdownDay[]): BreakdownView {
  const sum = (pick: (d: BreakdownDay) => number) => days.reduce((s, d) => s + pick(d), 0);
  const toolsUsedTotal = sum((d) => d.toolsUsed);
  const toolsUnusedTotal = sum((d) => d.toolsUnused);
  const historyCachedTotal = sum((d) => d.historyCached);
  const historyUncachedTotal = sum((d) => d.historyUncached);
  const toolsFull = toolsUsedTotal + toolsUnusedTotal;
  const historyFull = historyCachedTotal + historyUncachedTotal;
  return {
    days,
    toolsUsedTotal,
    toolsUnusedTotal,
    historyCachedTotal,
    historyUncachedTotal,
    toolsUnusedRate: toolsFull > 0 ? toolsUnusedTotal / toolsFull : 0,
    historyUncachedRate: historyFull > 0 ? historyUncachedTotal / historyFull : 0,
  };
}

export function buildDashboardModel(
  rows: DailyAggregateRow[],
  windowDays: string[],
): DashboardModel {
  const byDay = new Map(rows.map((r) => [r.day, r]));

  const tokensBars: DayBar[] = [];
  const costBars: DayBar[] = [];
  const latencyBars: DayBar[] = [];
  const breakdownDays: BreakdownDay[] = [];
  const srcSeries = emptySeries();
  const catSeries = emptyCatSeries();
  const runsSeries: number[] = [];

  let runs = 0;

  for (const isoDay of windowDays) {
    const r = byDay.get(isoDay);
    const label = dayLabel(isoDay);
    runsSeries.push(r?.runs ?? 0);

    const tokens = zero();
    const splits: CategorySplits = r?.splits ?? {
      history_cached: 0,
      history_uncached: 0,
      tools_used: 0,
      tools_unused: 0,
    };

    if (r) {
      runs += r.runs;
      for (const k of CONTEXT_SOURCES) tokens[k] = r.spend[k];
    }

    // Split-aware token values; cost/latency have no native per-source figure, so
    // distribute the day's total by each category's token weight (same
    // approximation as before, now at the finer split granularity).
    const tokensCat = toCategoryValues(tokens, splits);
    const dayTokens = sumAllCat(tokensCat);
    const costCat = catZero();
    const latencyCat = catZero();
    for (const c of CHART_CATEGORIES) {
      const w = dayTokens > 0 ? tokensCat[c] / dayTokens : 0;
      costCat[c] = (r?.costUsd ?? 0) * w;
      latencyCat[c] = (r?.latencyMs ?? 0) * w;
    }

    for (const k of CONTEXT_SOURCES) srcSeries[k].push(tokens[k]);
    for (const c of CHART_CATEGORIES) catSeries[c].push(tokensCat[c]);

    tokensBars.push({ label, values: tokensCat, total: dayTokens });
    costBars.push({ label, values: costCat, total: sumAllCat(costCat) });
    latencyBars.push({ label, values: latencyCat, total: sumAllCat(latencyCat) });
    breakdownDays.push({
      label,
      toolsUsed: splits.tools_used,
      toolsUnused: splits.tools_unused,
      historyCached: splits.history_cached,
      historyUncached: splits.history_uncached,
    });
  }

  const totalByCategory = (bars: DayBar[]): CategoryValues => {
    const acc = catZero();
    for (const b of bars) for (const c of CHART_CATEGORIES) acc[c] += b.values[c];
    return acc;
  };

  const toBySource = (cat: CategoryValues): SourceValues => {
    const acc = zero();
    for (const c of CHART_CATEGORIES) acc[CATEGORY_META[c].source] += cat[c];
    return acc;
  };

  const tokensCatTotals = totalByCategory(tokensBars);
  const costCatTotals = totalByCategory(costBars);
  const latencyCatTotals = totalByCategory(latencyBars);

  const totalLatencyMs = sumAllCat(latencyCatTotals);
  const spendTotal = sumAllCat(tokensCatTotals);

  // Latency is reported per run (the hero is avg ms/run), so the table's per-source /
  // per-category figures must also be per-run — otherwise they'd read as window-sum
  // ms (≈ runs× too large) next to a per-run hero. Tokens/cost stay window totals.
  const latencyCatPerRun = catZero();
  if (runs > 0) for (const c of CHART_CATEGORIES) latencyCatPerRun[c] = latencyCatTotals[c] / runs;

  const trend = {} as DashboardModel["trend"];
  for (const k of CONTEXT_SOURCES) trend[k] = trendOf(srcSeries[k]);
  const categoryTrend = {} as DashboardModel["categoryTrend"];
  for (const c of CHART_CATEGORIES) categoryTrend[c] = trendOf(catSeries[c]);

  const breakdown = buildBreakdownView(breakdownDays);

  return {
    runs,
    hasData: runs > 0,
    trend,
    categoryTrend,
    categorySeries: catSeries,
    runsSeries,
    breakdown,
    metrics: {
      tokens: {
        hero: spendTotal,
        bars: tokensBars,
        bySource: toBySource(tokensCatTotals),
        byCategory: tokensCatTotals,
        total: spendTotal,
      },
      cost: {
        hero: sumAllCat(costCatTotals),
        bars: costBars,
        bySource: toBySource(costCatTotals),
        byCategory: costCatTotals,
        total: sumAllCat(costCatTotals),
      },
      latency: {
        hero: runs > 0 ? totalLatencyMs / runs : 0,
        bars: latencyBars,
        bySource: toBySource(latencyCatPerRun),
        byCategory: latencyCatPerRun,
        // Per-run, matching byCategory/hero (so the source table + % legend reconcile).
        total: runs > 0 ? totalLatencyMs / runs : 0,
      },
    },
  };
}

/* --------------------------------- headline KPIs -------------------------- */

/** Direction + magnitude of a within-window change (second half vs first half). */
export type Delta = { pct: number; dir: "up" | "flat" | "down" };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * In-window trend delta: compare the window's most-recent half against its oldest
 * half (equal day counts, dropping the middle day on an odd length). Returns null
 * when there's too little data or no baseline (the earlier half is empty) — a delta
 * against zero is "∞", not information. A ±0.5% dead-band reads as flat.
 */
export function halfDelta(series: number[]): Delta | null {
  if (series.length < 4) return null;
  const mid = Math.floor(series.length / 2);
  const first = sum(series.slice(0, mid));
  const second = sum(series.slice(series.length - mid));
  if (first <= 0) return null;
  const pct = (second - first) / first;
  return { pct, dir: pct > 0.005 ? "up" : pct < -0.005 ? "down" : "flat" };
}

/** A headline vital: a formatted figure, its daily series, and its in-window delta. */
export type Kpi = {
  key: Metric | "runs";
  label: string;
  value: string;
  sub: string;
  series: number[];
  delta: Delta | null;
  /** Whether a rising value is the good outcome — colors the delta (runs up = good). */
  upIsGood: boolean;
};

/**
 * The four vitals the dashboard leads with. Tokens/cost are window sums; latency is
 * the per-run average and its series is each day's own per-run average (day sum ÷
 * day runs), so its delta compares speed, not volume. Runs is the raw call count.
 */
export function buildKpis(model: DashboardModel): Kpi[] {
  const { metrics, runs, runsSeries } = model;
  const tokenSeries = metrics.tokens.bars.map((b) => b.total);
  const costSeries = metrics.cost.bars.map((b) => b.total);
  const latencySeries = metrics.latency.bars.map((b, i) => {
    const r = runsSeries[i] ?? 0;
    return r > 0 ? b.total / r : 0;
  });
  return [
    {
      key: "tokens",
      label: "Input tokens",
      value: fmtTokens(metrics.tokens.total),
      sub: "sent to the model",
      series: tokenSeries,
      delta: halfDelta(tokenSeries),
      upIsGood: false,
    },
    {
      key: "cost",
      label: "Cost",
      value: fmtCost(metrics.cost.total),
      sub: "across every run",
      series: costSeries,
      delta: halfDelta(costSeries),
      upIsGood: false,
    },
    {
      key: "latency",
      label: "Avg latency",
      value: fmtLatency(metrics.latency.hero),
      sub: "per run",
      series: latencySeries,
      delta: halfDelta(latencySeries),
      upIsGood: false,
    },
    {
      key: "runs",
      label: "Runs",
      value: fmtCount(runs),
      sub: "agent calls",
      series: runsSeries,
      delta: halfDelta(runsSeries),
      upIsGood: true,
    },
  ];
}

/* ------------------------------- efficiency ------------------------------- */

/**
 * The reclaimable-context story rolled into one meter: how much of the input budget
 * is lean vs. the tokens Ratel can reclaim (tool defs shipped-but-never-called +
 * history re-read uncached). Efficiency is the kept share of all input tokens; the
 * per-run figures are what a single run carries. This is the same measured waste the
 * suggestions rank, framed as the headline "you could reclaim ~N / run".
 */
export type EfficiencyView = {
  /** True once there's any measured reclaimable waste — else the meter is all "kept". */
  hasWaste: boolean;
  /** Kept share of input tokens, 0..1 (1 − reclaimable/total). */
  efficiency: number;
  reclaimablePerRun: number;
  keptPerRun: number;
  totalPerRun: number;
  unusedToolsPerRun: number;
  uncachedHistoryPerRun: number;
  /** Reclaimable share of input tokens, 0..1 — the coral slice of the meter. */
  reclaimableShare: number;
};

export function buildEfficiency(model: DashboardModel): EfficiencyView {
  const { runs, breakdown, metrics } = model;
  const total = metrics.tokens.total;
  const reclaimable = breakdown.toolsUnusedTotal + breakdown.historyUncachedTotal;
  const kept = Math.max(total - reclaimable, 0);
  const per = (n: number) => (runs > 0 ? n / runs : 0);
  return {
    hasWaste: reclaimable > 0,
    efficiency: total > 0 ? kept / total : 1,
    reclaimablePerRun: per(reclaimable),
    keptPerRun: per(kept),
    totalPerRun: per(total),
    unusedToolsPerRun: per(breakdown.toolsUnusedTotal),
    uncachedHistoryPerRun: per(breakdown.historyUncachedTotal),
    reclaimableShare: total > 0 ? reclaimable / total : 0,
  };
}

/* -------------------------------- tool usage ------------------------------ */

/** Which measure the Tools chart bars represent — mirrors the main chart's switch. */
export type ToolMetric = "tokens" | "cost" | "calls";

export type RuntimeCatalogDefinition = {
  entryId: string;
  name: string;
  description: string;
  tags: string[];
  inputSchema: unknown;
  outputSchema: unknown;
  searchableDescription: string;
  searchableDescriptionOverridden: boolean;
  useCloudDefinitions?: boolean | null;
  provenance: "events" | "snapshot" | "both";
  searchableDescriptionOverride: string | null;
  lastSeenAt: Date;
};

export type RuntimeObservedCatalogEntry = {
  entryId: null;
  name: string;
  provenance: "observed";
  lastSeenAt: Date;
};

export type RuntimeCatalogEntry = RuntimeCatalogDefinition | RuntimeObservedCatalogEntry;

export type RuntimeToolDefinition = RuntimeCatalogDefinition;
export type RuntimeObservedTool = RuntimeObservedCatalogEntry;
export type RuntimeToolCatalogEntry = RuntimeCatalogEntry;

export const TOOL_METRIC_META: Record<ToolMetric, { label: string }> = {
  tokens: { label: "Tokens" },
  cost: { label: "Cost" },
  calls: { label: "Calls" },
};

/**
 * One tool's window totals, each split into the portion from runs where the model
 * called it (`used`) and runs where it shipped in the prompt but went uncalled
 * (`unused`). Used/unused is a *per-run* fact, so a single tool can carry both:
 * called in some turns, dead weight in others.
 */
export type ToolStatRow = {
  name: string;
  calls: number;
  usedTokens: number;
  unusedTokens: number;
  usedCost: number;
  unusedCost: number;
  definition: RuntimeToolDefinition | null;
};

export type ToolUsageView = {
  /** All tools, default-sorted by total token footprint (the chart re-sorts). */
  tools: ToolStatRow[];
};

/** The [used, unused] pair for a tool under one metric — the two stack segments. */
export function toolMetricSplit(t: ToolStatRow, m: ToolMetric): [number, number] {
  if (m === "cost") return [t.usedCost, t.unusedCost];
  if (m === "calls") return [t.calls, 0]; // a call is used by definition
  return [t.usedTokens, t.unusedTokens];
}

/** A tool's total under one metric — the full bar height (used + unused). */
export function toolMetricTotal(t: ToolStatRow, m: ToolMetric): number {
  const [used, unused] = toolMetricSplit(t, m);
  return used + unused;
}

/**
 * Merge the window's per-event tool maps into one row per tool, bucketing each
 * event's footprint by whether the tool was called *that* run. Cost isn't tracked
 * per tool, so the tools' total cost is spread across tools (and their used/unused
 * halves) by token share — the same proportional split the dashboard uses.
 */
export function buildToolUsage(
  perEvent: ToolsByName[],
  toolsCostUsd: number,
  definitions: readonly RuntimeToolDefinition[] = [],
): ToolUsageView {
  const merged = new Map<string, { calls: number; usedTokens: number; unusedTokens: number }>();
  for (const map of perEvent) {
    for (const [name, stat] of Object.entries(map)) {
      const e = merged.get(name) ?? { calls: 0, usedTokens: 0, unusedTokens: 0 };
      e.calls += stat.calls;
      if (stat.calls > 0) e.usedTokens += stat.tokens;
      else e.unusedTokens += stat.tokens;
      merged.set(name, e);
    }
  }

  const totalTokens = [...merged.values()].reduce((n, s) => n + s.usedTokens + s.unusedTokens, 0);
  const costPerToken = totalTokens > 0 ? toolsCostUsd / totalTokens : 0;
  const definitionByName = new Map(definitions.map((definition) => [definition.name, definition]));

  const tools: ToolStatRow[] = [...merged.entries()]
    .map(([name, s]) => ({
      name,
      calls: s.calls,
      usedTokens: s.usedTokens,
      unusedTokens: s.unusedTokens,
      usedCost: s.usedTokens * costPerToken,
      unusedCost: s.unusedTokens * costPerToken,
      definition: definitionByName.get(name) ?? null,
    }))
    .sort(
      (a, b) =>
        b.usedTokens + b.unusedTokens - (a.usedTokens + a.unusedTokens) ||
        a.name.localeCompare(b.name),
    );

  return { tools };
}

/** Format a Tools-chart value for the active metric (cost as $, else integer/k). */
export function formatToolMetric(m: ToolMetric, v: number): string {
  return m === "cost" ? fmtCost(v) : fmtTokens(v);
}

/* ------------------------------- suggestions ------------------------------ */

export type Severity = "high" | "medium" | "low";

export type Suggestion = {
  source: ContextSource;
  severity: Severity;
  title: string;
  /** One short phrase for the collapsed row — the gist without the full paragraph. */
  hint: string;
  body: string;
  /** Per-run tokens spent in this source (the cost we can actually measure). */
  perRunTokens: number;
  manual: string;
  ratel: string;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Heuristic suggestions from real signals (per-source share + trend). We surface
 * the per-run token cost of each high-share source rather than a precise
 * "reclaimable" figure, which would require per-skill/per-tool usage we don't yet
 * ingest. Ranked by per-run token cost.
 */
export function buildSuggestions(model: DashboardModel): Suggestion[] {
  const { metrics, runs, trend, breakdown } = model;
  if (runs === 0) return [];
  const tokens = metrics.tokens;
  const total = tokens.total || 1;
  const share = (k: ContextSource) => tokens.bySource[k] / total;
  const perRun = (k: ContextSource) => tokens.bySource[k] / runs;

  const out: Suggestion[] = [];

  // Unused tools is now an EXACT measurement: tool definitions shipped in the
  // prompt whose names never appear in a tool_call this window. That's the "%
  // unused" headline and the tokens Ratel reclaims by compacting the toolset.
  const unusedRate = breakdown.toolsUnusedRate;
  const unusedPerRun = breakdown.toolsUnusedTotal / runs;

  if (share("tools") >= 0.3 || unusedRate >= 0.25) {
    out.push({
      source: "tools",
      severity: "high",
      title:
        unusedRate > 0
          ? `${pct(unusedRate)} of your tools go unused`
          : "Tools dominate your context budget",
      hint:
        unusedRate > 0
          ? "tool defs shipped every prompt, never called"
          : "tool defs crowd every prompt",
      body:
        unusedRate > 0
          ? `About ${pct(unusedRate)} of your tool definitions (roughly ${fmtTokens(unusedPerRun)} every run) ship in the prompt but are never called. Ratel compacts your toolset on the fly, loading only the tools a turn actually needs.`
          : `Tool definitions are ${pct(share("tools"))} of input tokens, about ${fmtTokens(perRun("tools"))} every run. If most aren't called each turn, they're dead weight in the prompt.`,
      perRunTokens: perRun("tools"),
      manual: "Trim unused tool definitions",
      ratel: "compact your tools with Ratel",
    });
  }

  if (share("skills") >= 0.2) {
    out.push({
      source: "skills",
      severity: "high",
      title: "Skills are loaded on every prompt",
      hint: "loaded whether or not they're used this turn",
      body: `Skills account for ${pct(share("skills"))} of input tokens (${fmtTokens(perRun("skills"))} per run) whether or not they're used this turn.`,
      perRunTokens: perRun("skills"),
      manual: "Gate skills by route",
      ratel: "let Ratel inject skills on demand",
    });
  }

  // Uncached history is history the provider re-read at full price this window —
  // the part prompt-caching didn't cover, and what pruning/summarization targets.
  const uncachedRate = breakdown.historyUncachedRate;
  const uncachedPerRun = breakdown.historyUncachedTotal / runs;

  if (share("history") >= 0.2 || uncachedRate >= 0.5 || trend.history === "up") {
    const growing = trend.history === "up";
    out.push({
      source: "history",
      severity: growing || uncachedRate >= 0.6 ? "high" : "medium",
      title:
        uncachedRate >= 0.5
          ? `${pct(uncachedRate)} of history is read uncached`
          : "History keeps growing",
      hint: growing
        ? "trending up, re-read at full price"
        : "re-read uncached, compounds each turn",
      body: `Conversation history is ${pct(share("history"))} of input tokens (${fmtTokens(perRun("history"))} per run)${growing ? ", trending up this period" : ""}. About ${fmtTokens(uncachedPerRun)} per run is re-read uncached, which compounds every turn unless pruned.`,
      perRunTokens: perRun("history"),
      manual: "Add a summarization step",
      ratel: "prune dead history with Ratel",
    });
  }

  if (share("memory") >= 0.1) {
    out.push({
      source: "memory",
      severity: "low",
      title: "Memory is hard to verify",
      hint: "retrieved context, attribution approximate",
      body: `Retrieved memory adds ${fmtTokens(perRun("memory"))} per run (${pct(share("memory"))}). Attribution here is approximate, so it's worth a relevance review before cutting.`,
      perRunTokens: perRun("memory"),
      manual: "Review retrieval relevance",
      ratel: "tune retrieval with Ratel",
    });
  }

  // Tools is Ratel's headline win (compaction), so surface it first when it
  // fires; rank the rest by per-run context cost.
  return out.sort((a, b) => {
    const at = a.source === "tools" ? 1 : 0;
    const bt = b.source === "tools" ? 1 : 0;
    if (at !== bt) return bt - at;
    return b.perRunTokens - a.perRunTokens;
  });
}

/* -------------------------------- formatting ------------------------------ */

/** Compact token count: `M` past a million, `k` past a thousand, else whole. */
export function fmtTokens(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) {
    const m = v / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (abs >= 1000) return `${Math.round(v / 1000)}k`;
  return `${Math.round(v)}`;
}

/**
 * Like {@link fmtTokens} but keeps one decimal of `k` below 10k — so a headline
 * figure and its components reconcile (2.9k + 1.5k reads as ~4.4k, not 3k + 2k ≠ 4k).
 */
export function fmtTokensFine(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) {
    const m = v / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (abs >= 10_000) return `${Math.round(v / 1000)}k`;
  if (abs >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return `${Math.round(v)}`;
}

/** A signed whole-percent for a delta chip, e.g. +12% / −8% (true minus glyph). */
export function fmtDelta(pct: number): string {
  const rounded = Math.round(pct * 100);
  if (rounded === 0) return "0%";
  return rounded > 0 ? `+${rounded}%` : `−${Math.abs(rounded)}%`;
}

/** Whole-percent label, e.g. 0.62 → "62%". */
export function fmtPercent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function fmtLatency(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.round(v)}ms`;
}

export function formatMetric(metric: Metric, v: number): string {
  if (metric === "cost") return fmtCost(v);
  if (metric === "latency") return fmtLatency(v);
  return fmtTokens(v);
}

export const METRIC_META: Record<Metric, { label: string; heroSuffix: string }> = {
  tokens: { label: "Tokens", heroSuffix: "total input tokens" },
  latency: { label: "Latency", heroSuffix: "avg latency / run" },
  cost: { label: "Cost", heroSuffix: "total cost" },
};

export { CONTEXT_SOURCES, SOURCE_META };
