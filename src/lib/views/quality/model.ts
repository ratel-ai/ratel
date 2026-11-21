import { projectRoot } from "@/lib/console/navigation";
import { RANGE_PRESETS, type RangePreset, type ResolvedRange } from "@/lib/synthesis/dashboard";
import { resolveTraceRange, type TraceSearchParamValue } from "@/lib/synthesis/traces/view";

/**
 * Quality as plain data: which tabs exist, where they live,
 * the time window and the number formats every tab shares. Pure, so the pages
 * stay thin loaders and the rules here are tested without a database.
 */

/**
 * Misses (searches the right tool did not win), Descriptions (how often the
 * right tool is found, and the searchable-description rewrites that would find
 * it more often) and Experiments.
 */
export type QualityTab = "misses" | "descriptions" | "experiments";

/** Where each tab's data comes from, so a tab whose source is off is never shown. */
export interface QualitySources {
  /** `cloud-match-quality`: the answer key, the runs and their rewrites. */
  matchQuality: boolean;
  /** `cloud-calibration-v2`: experiments that rank beside the current search. */
  calibration: boolean;
}

const TAB_ORDER: readonly QualityTab[] = ["misses", "descriptions", "experiments"];

const TAB_LABEL: Record<QualityTab, string> = {
  misses: "Misses",
  descriptions: "Descriptions",
  experiments: "Experiments",
};

export function visibleTabs(sources: QualitySources): QualityTab[] {
  return TAB_ORDER.filter((tab) =>
    tab === "experiments" ? sources.calibration : sources.matchQuality,
  );
}

/**
 * Quality › Descriptions, the page other surfaces link to for a description
 * update: `?tool=<toolId>` opens that tool (its rewrite, or its description
 * with none yet), `?peek=rewrite:<proposalId>` opens one rewrite.
 */
export function descriptionsHref(
  projectId: string,
  open: { tool?: string | null; rewrite?: string | null } = {},
): string {
  const params = new URLSearchParams();
  if (open.rewrite) params.set("peek", rewritePeek(open.rewrite));
  else if (open.tool) params.set("tool", open.tool);
  const query = params.toString();
  return `${qualityTabHref(projectId, "descriptions")}${query ? `?${query}` : ""}`;
}

/** A rewrite's `?peek=` value: the id Fixes and Agent health use for it too. */
export function rewritePeek(proposalId: string): string {
  return `rewrite:${proposalId}`;
}

const PROPOSAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An old Suggestions `?peek=` (a bare proposal id), or null when it is not one. */
export function legacySuggestionId(raw: string | readonly string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && PROPOSAL_ID.test(value) ? value : null;
}

export function qualityRoot(projectId: string): string {
  return `${projectRoot(projectId)}/quality`;
}

export function qualityTabHref(projectId: string, tab: QualityTab, search = ""): string {
  const root = qualityRoot(projectId);
  return `${tab === "misses" ? root : `${root}/${tab}`}${search}`;
}

export interface QualityTabLink {
  href: string;
  label: string;
  exact?: boolean;
  meta?: string;
}

/** The tab strip: each tab carries the time window, so moving between them keeps it. */
export function qualityTabLinks(
  projectId: string,
  tabs: readonly QualityTab[],
  search: string,
  meta: Partial<Record<QualityTab, number>> = {},
): QualityTabLink[] {
  return tabs.map((tab) => ({
    href: qualityTabHref(projectId, tab, search),
    label: TAB_LABEL[tab],
    ...(tab === "misses" ? { exact: true } : {}),
    ...(meta[tab] !== undefined && meta[tab]! > 0 ? { meta: String(meta[tab]) } : {}),
  }));
}

/**
 * Where the v1 Calibration index sends a v2 reader: Experiments, keeping what
 * still means something there (the window, and the experiment a Match quality
 * link asked for). The legacy `project` slug and the browser's paging do not.
 */
export function calibrationRedirectHref(
  projectId: string,
  params: Record<string, string | readonly string[] | undefined>,
): string {
  const kept = new URLSearchParams();
  for (const key of ["experiment", "range", "from", "to"]) {
    const raw = params[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value !== "") kept.set(key, value);
  }
  const query = kept.toString();
  return `${qualityTabHref(projectId, "experiments")}${query ? `?${query}` : ""}`;
}

/* - Time window -------------------------------------------------------------- */

export const DEFAULT_QUALITY_RANGE: RangePreset = "7d";

export interface QualityWindowParams {
  range?: TraceSearchParamValue;
  from?: TraceSearchParamValue;
  to?: TraceSearchParamValue;
}

/** The window from `?range=` (and `from`/`to` for a custom one), as Traces reads it. */
export function resolveQualityWindow(params: QualityWindowParams, now: Date): ResolvedRange {
  return resolveTraceRange({ range: params.range, from: params.from, to: params.to }, now);
}

/** The query string that carries the window to another tab, or "" for the default. */
export function windowSearch(range: Pick<ResolvedRange, "preset" | "from" | "to">): string {
  if (range.preset === DEFAULT_QUALITY_RANGE) return "";
  const params = new URLSearchParams({ range: range.preset });
  if (range.preset === "custom") {
    params.set("from", range.from);
    params.set("to", range.to);
  }
  return `?${params.toString()}`;
}

export function windowLabel(range: Pick<ResolvedRange, "preset" | "label">): string {
  if (range.preset === "custom") return range.label;
  return RANGE_PRESETS.find((preset) => preset.id === range.preset)?.label ?? range.label;
}

/** `path` with a preset window and any other params the tab keeps (an open experiment). */
export function windowHref(
  path: string,
  preset: RangePreset,
  keep: Record<string, string | null> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(keep)) if (value) params.set(key, value);
  if (preset !== DEFAULT_QUALITY_RANGE) params.set("range", preset);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** `path` with the page's window query and extra params on top (an open experiment). */
export function withParams(
  path: string,
  search: string,
  extra: Record<string, string | null>,
): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** The header's window menu: every preset as a link on this tab. */
export function windowOptions(
  path: string,
  current: Pick<ResolvedRange, "preset">,
  keep: Record<string, string | null> = {},
): { id: RangePreset; label: string; href: string; active: boolean }[] {
  return RANGE_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    href: windowHref(path, preset.id, keep),
    active: current.preset === preset.id,
  }));
}

const WIDER: Partial<Record<RangePreset, RangePreset>> = {
  "7d": "30d",
  "14d": "30d",
  "30d": "3m",
  "3m": "12m",
};

/** The next longer preset, for an empty window's one action; null past the longest. */
export function widerWindow(
  path: string,
  current: Pick<ResolvedRange, "preset">,
  keep: Record<string, string | null> = {},
): { href: string; label: string } | null {
  if (current.preset === "custom") return null;
  const next = WIDER[current.preset];
  if (!next) return null;
  const label = RANGE_PRESETS.find((preset) => preset.id === next)?.label ?? next;
  return { href: windowHref(path, next, keep), label };
}

/** The window inside a sentence: "the last 7 days", or "this window" for a custom one. */
export function windowPhrase(range: Pick<ResolvedRange, "preset" | "label">): string {
  return range.preset === "custom" ? "this window" : `the ${windowLabel(range).toLowerCase()}`;
}

/** What a change figure compares against: "vs the previous 7 days". */
export function versusPhrase(range: Pick<ResolvedRange, "preset" | "label">): string {
  if (range.preset === "custom") return "vs the window before";
  return `vs the ${windowLabel(range)
    .toLowerCase()
    .replace(/^last /, "previous ")}`;
}

/** The same stretch of time one window earlier, for change figures. */
export function previousWindow(range: Pick<ResolvedRange, "since" | "until">): {
  since: Date;
  until: Date;
} {
  const length = range.until.getTime() - range.since.getTime();
  return { since: new Date(range.since.getTime() - length), until: range.since };
}

/* - Numbers ------------------------------------------------------------------ */

/** Shown where a number is missing. An en dash: never an em dash in UI. */
export const NO_VALUE = "–";

/** A share as a whole percent: "74%". */
export function percent(share: number | null | undefined): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return NO_VALUE;
  return `${Math.round(share * 100)}%`;
}

export type ChangeDirection = "up" | "down" | "flat";

export interface Change {
  direction: ChangeDirection;
  /** Signed and formatted: "+4 pts", "-2 pts". */
  text: string;
}

/** The change between two shares in percentage points, so it never reads as a percent of a percent. */
export function pointChange(current: number | null, previous: number | null): Change | null {
  if (
    current === null ||
    previous === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  ) {
    return null;
  }
  const whole = Math.round((current - previous) * 100);
  if (whole === 0) return { direction: "flat", text: "0 pts" };
  return {
    direction: whole > 0 ? "up" : "down",
    text: `${whole > 0 ? "+" : "-"}${Math.abs(whole)} pts`,
  };
}

/** "1 search", "12 searches". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}
