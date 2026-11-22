/**
 * The five canonical context sources — what fills an agent's input prompt.
 * Single source of truth shared by the ingest schema (events.tokens_by_category),
 * the dashboard chart/table/legend, and the suggestion rules. The color for each
 * lives as a `--color-ctx-*` token in @ratel/brand/theme.css.
 */
export const CONTEXT_SOURCES = ["skills", "tools", "history", "memory", "user_input"] as const;

export type ContextSource = (typeof CONTEXT_SOURCES)[number];

/** Input-token counts attributed to each context source for a single run. */
export type TokensByCategory = Record<ContextSource, number>;

/**
 * Tokens Ratel kept OUT of the prompt for a single run, per source — runs exactly
 * parallel to {@link TokensByCategory}. For each source, `tokens_by_category[s]`
 * is what was actually sent (the selected slice) and `saved_by_category[s]` is
 * what Ratel pruned, so their sum is the counterfactual "what it would have been"
 * without Ratel. Selection saves on `tools` and `skills`; the rest are typically 0.
 */
export type SavedByCategory = Record<ContextSource, number>;

/**
 * Estimated tokens Ratel *could* have saved this run if its selection engine were
 * enabled, per source — the "potential" twin of {@link SavedByCategory}. Emitted
 * when the SDK is only observing (not selecting): it shadow-ranks the tools it can
 * already see and reports the would-be reduction, so a not-yet-Ratel user sees
 * "you could save ~N" without any behavior change. Realized savings take
 * precedence over potential wherever both exist.
 */
export type SaveableByCategory = Record<ContextSource, number>;

/** All-zero source map — the baseline for a run that reported no savings. */
export const ZERO_SAVED: SavedByCategory = {
  skills: 0,
  tools: 0,
  history: 0,
  memory: 0,
  user_input: 0,
};

/**
 * Chart/table categories: the five sources, but with `tools` split into
 * used/unused and `history` into cached/uncached. This is what the stacked chart
 * renders (each split half is its own segment) and what the table groups under a
 * source header. Ordered so each source's two halves sit adjacent in the stack.
 */
export const CHART_CATEGORIES = [
  "skills",
  "tools_used",
  "tools_unused",
  "history_cached",
  "history_uncached",
  "memory",
  "user_input",
] as const;

export type ChartCategory = (typeof CHART_CATEGORIES)[number];

/**
 * Sources rendered as a group of two sub-categories in the table; every other
 * source renders as a single row. The tuple is [primary, reclaimable] and its
 * order matches the chart stack.
 */
export const SOURCE_SPLITS: Partial<
  Record<ContextSource, readonly [ChartCategory, ChartCategory]>
> = {
  tools: ["tools_used", "tools_unused"],
  history: ["history_cached", "history_uncached"],
};

/**
 * Display metadata per chart category. `source` ties a split half back to its
 * parent; `short`/`note` label the two sub-rows in the grouped table; `label` is
 * the full legend text. Non-split categories reuse their source's label/color.
 */
export const CATEGORY_META: Record<
  ChartCategory,
  { source: ContextSource; label: string; short: string; note: string; cssVar: string }
> = {
  skills: {
    source: "skills",
    label: "Skills",
    short: "Skills",
    note: "loaded whether or not they're used",
    cssVar: "--color-ctx-skills",
  },
  tools_used: {
    source: "tools",
    label: "Tools used",
    short: "Used",
    note: "called at least once this window",
    cssVar: "--color-ctx-tools-used",
  },
  tools_unused: {
    source: "tools",
    label: "Tools unused",
    short: "Unused",
    note: "shipped in every prompt but never called",
    cssVar: "--color-ctx-tools-unused",
  },
  history_cached: {
    source: "history",
    label: "History cached",
    short: "Cached",
    note: "served from the provider's prompt cache",
    cssVar: "--color-ctx-history-cached",
  },
  history_uncached: {
    source: "history",
    label: "History uncached",
    short: "Uncached",
    note: "re-read at full price every turn",
    cssVar: "--color-ctx-history-uncached",
  },
  memory: {
    source: "memory",
    label: "Memory",
    short: "Memory",
    note: "retrieved context; attribution is approximate",
    cssVar: "--color-ctx-memory",
  },
  user_input: {
    source: "user_input",
    label: "User input",
    short: "User input",
    note: "the irreducible floor",
    cssVar: "--color-ctx-user-input",
  },
};

/** Display metadata for each source — drives the chart legend, table, and copy. */
export const SOURCE_META: Record<
  ContextSource,
  { label: string; description: string; cssVar: string }
> = {
  skills: {
    label: "Skills",
    description: "loaded whether or not they're used",
    cssVar: "--color-ctx-skills",
  },
  tools: {
    label: "Tools",
    description: "definitions ship in every prompt",
    cssVar: "--color-ctx-tools",
  },
  history: {
    label: "History",
    description: "grows every turn, rarely pruned",
    cssVar: "--color-ctx-history",
  },
  memory: {
    label: "Memory",
    description: "retrieved context; attribution is approximate",
    cssVar: "--color-ctx-memory",
  },
  user_input: {
    label: "User input",
    description: "the irreducible floor",
    cssVar: "--color-ctx-user-input",
  },
};
