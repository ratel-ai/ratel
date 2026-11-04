import { projectRoot } from "@/lib/console/navigation";
import { loadToolCorpus } from "@/lib/ingest/runtime-catalog/inventory";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { pickTunedArm } from "@/lib/synthesis/match-quality/evidence";
import type {
  MatchQualityProposalRow,
  MatchQualityRunRow,
} from "@/lib/synthesis/match-quality/schema";
import {
  countCapturedSearches,
  isSearchTelemetry,
  loadSourceSelections,
  SEARCH_TELEMETRY_SOURCE,
} from "@/lib/synthesis/match-quality/search-source";
import { type EvaluableSelection, pickBaselineArm } from "@/lib/synthesis/quality/ground-truth";
import { listQualityCalibrations, MAX_SELECTIONS } from "@/lib/synthesis/quality/queries";
import {
  buildHeadline,
  type EvidenceSourceLabel,
  type Headline,
  onTier,
  tierObservations,
} from "./headline";
import { MAX_LISTED_MISSES, type MissRow, toMissRows } from "./miss-rows";
import {
  groupMisses,
  type MissGroup,
  scoreSearches,
  type ToolTally,
  toolTallies,
  within,
} from "./misses";
import { previousWindow } from "./model";
import { experimentTraceIds, searchTraceIds, tracesWithSpans } from "./queries";
import { searchTest } from "./test-search";

/**
 * The header's headline and the Misses tab, from one read: every recorded
 * search in the window and the one before it, the answer key attached. The
 * headline reads one evidence tier (`headline.ts`); the list shows every
 * search with a known right tool. Rows, with their tool names and trace links,
 * are only built for Misses, each extra read with its own fallback.
 */

/** The other variant of an experiment, read on our headline's tier and searches. */
export interface TheirRanking {
  /** The variant's name, as the experiment calls it. */
  arm: string;
  /** True when this is the list the agent was shown. */
  served: boolean;
  first: Headline;
  found: Headline;
}

export interface QualityEvidence {
  /** Searches recorded in the window, answered or not. */
  searches: number;
  /** Searches with a known right tool, any evidence: what the list stands on. */
  answered: number;
  headline: Headline;
  /** How often the right tool is in our list at all, same tier and searches as `headline`. */
  found: Headline;
  /** The customer's own ranking, where an experiment ranks one beside ours; null without one. */
  theirs: TheirRanking | null;
  /** Per right tool: its searches in the window and how many had it first or at all. */
  tools: Record<string, ToolTally>;
  groups: MissGroup[];
  /** Misses in the window, before the list's cap. */
  missCount: number;
  /** True when this window held more searches than one read takes, so only the newest were counted. */
  cut: boolean;
  /** How many searches one read takes, for saying so when `cut`. */
  readLimit: number;
  source: EvidenceSourceLabel;
  /** The source's name as the runs store it (a calibration, or plain search telemetry). */
  experimentName: string;
}

const NO_HEADLINE: Headline = {
  tier: null,
  n: 0,
  hits: 0,
  share: null,
  change: null,
  trend: [],
  trendUnit: "day",
};

export const EMPTY_EVIDENCE: QualityEvidence = {
  searches: 0,
  answered: 0,
  headline: NO_HEADLINE,
  found: NO_HEADLINE,
  theirs: null,
  tools: {},
  groups: [],
  missCount: 0,
  cut: false,
  readLimit: MAX_SELECTIONS,
  source: { kind: "telemetry" },
  experimentName: SEARCH_TELEMETRY_SOURCE,
};

type Window = { since: Date; until: Date };

/** Null when the read failed: the tab says so in place and the rest of the page still works. */
export async function loadQualityEvidence({
  projectId,
  window,
  run,
}: {
  projectId: string;
  window: Window;
  run: MatchQualityRunRow | null;
}): Promise<QualityEvidence | null> {
  return loadOrFallback({
    operation: "quality_v2_misses",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () => readEvidence(projectId, window, run),
  });
}

async function readEvidence(
  projectId: string,
  window: Window,
  run: MatchQualityRunRow | null,
): Promise<QualityEvidence> {
  const [calibrations, captured] = await Promise.all([
    listQualityCalibrations(projectId, window),
    countCapturedSearches(projectId, window),
  ]);
  const source = chooseSource(
    [
      ...calibrations.map((calibration) => calibration.experimentName),
      ...(captured > 0 ? [SEARCH_TELEMETRY_SOURCE] : []),
    ],
    run?.experimentName ?? null,
  );
  if (!source) return EMPTY_EVIDENCE;

  const before = previousWindow(window);
  const { selections, diagnostics } = await loadSourceSelections(projectId, source, {
    since: before.since,
    until: window.until,
  });
  const ourArm = resolveOurArm(selections, source, run);
  if (!ourArm) return EMPTY_EVIDENCE;

  const current = within(selections, window);
  const previous = within(selections, before);
  const scored = scoreSearches(current, ourArm);
  const groups = groupMisses(scored);
  // The read keeps the newest searches, so a cut that reached this window
  // cost it its oldest ones, and either way the window before is partial.
  const comparable = !diagnostics.truncated;
  const oursNow = tierObservations(current, ourArm);
  const oursBefore = tierObservations(previous, ourArm);
  const headline = buildHeadline(oursNow, oursBefore, window, comparable);
  return {
    searches: current.length,
    answered: scored.length,
    headline,
    found: buildHeadline(oursNow, oursBefore, window, comparable, "found"),
    theirs: theirRanking(current, previous, ourArm, headline.tier, window, comparable),
    tools: toolTallies(scored),
    groups,
    missCount: groups.length,
    cut: windowCut(diagnostics.truncated, selections, window),
    readLimit: MAX_SELECTIONS,
    source: isSearchTelemetry(source)
      ? { kind: "telemetry" }
      : { kind: "experiment", name: source, variant: ourArm },
    experimentName: source,
  };
}

/**
 * The customer's own ranking beside ours: the experiment's one other variant,
 * scored on our headline's tier over the same searches, so the two numbers are
 * measured the same way. Null without an experiment, or when that tier has
 * nothing for it (a served list never counts on "Seen it run").
 */
export function theirRanking(
  current: readonly EvaluableSelection[],
  previous: readonly EvaluableSelection[],
  ourArm: string,
  tier: Headline["tier"],
  window: Window,
  comparable: boolean,
): TheirRanking | null {
  const others = [
    ...new Set(current.flatMap((selection) => selection.arms.map((arm) => arm.arm))),
  ].filter((arm) => arm !== ourArm);
  if (others.length !== 1) return null;
  const arm = others[0]!;
  const now = onTier(tierObservations(current, arm), tier);
  if (!now) return null;
  const before = onTier(tierObservations(previous, arm), tier) ?? { judged: [], seen: [] };
  const served = current.some((selection) =>
    selection.arms.some((ranking) => ranking.arm === arm && ranking.role === "serving"),
  );
  return {
    arm,
    served,
    first: buildHeadline(now, before, window, comparable),
    found: buildHeadline(now, before, window, comparable, "found"),
  };
}

/** Whether a truncated read (newest kept, oldest first) dropped searches from this window itself. */
export function windowCut(
  truncated: boolean,
  selections: readonly Pick<EvaluableSelection, "occurredAt">[],
  window: Window,
): boolean {
  if (!truncated) return false;
  const oldest = selections[0];
  return oldest === undefined || oldest.occurredAt >= window.since;
}

/**
 * Which recorded searches to read, from the sources with any in the window.
 * The latest run's own source wins when it has some, so Misses and the
 * suggestions drafted from that run stand on the same searches; otherwise the
 * run's rule applies: the busiest calibration first (listed busiest first),
 * plain search telemetry after it.
 */
export function chooseSource(
  available: readonly string[],
  runSource: string | null,
): string | null {
  if (runSource && available.includes(runSource)) return runSource;
  return available[0] ?? null;
}

/**
 * Ours is the ranking the rewrites can change. A single-engine source has only
 * ours. For an experiment, the run's arms count only when the run read this
 * same experiment: another experiment's baseline could be this one's own
 * ranking. Otherwise the run's rule: whichever arm is not the baseline.
 */
export function resolveOurArm(
  selections: readonly EvaluableSelection[],
  experimentName: string,
  run: Pick<MatchQualityRunRow, "experimentName" | "tunedArm" | "baselineArm"> | null,
): string | null {
  const arms = [
    ...new Set(selections.flatMap((selection) => selection.arms.map((arm) => arm.arm))),
  ];
  if (arms.length <= 1) return arms[0] ?? null;
  const sameSource = run !== null && run.experimentName === experimentName;
  if (sameSource && run.tunedArm && arms.includes(run.tunedArm)) return run.tunedArm;
  const runBaseline =
    sameSource && run.baselineArm && arms.includes(run.baselineArm) ? run.baselineArm : null;
  return pickTunedArm(selections, runBaseline ?? pickBaselineArm(selections));
}

/** The Misses rows: names and trace links read here, each degrading on its own. */
export async function loadMissRows({
  projectId,
  evidence,
  window,
  proposals = [],
}: {
  projectId: string;
  evidence: QualityEvidence;
  window: Window;
  /** The analysis's rewrites, so a miss can point at its tool's. */
  proposals?: readonly Pick<MatchQualityProposalRow, "entryId" | "status">[];
}): Promise<MissRow[]> {
  if (evidence.groups.length === 0) return [];
  const distinctId = `project:${projectId}`;
  const [names, traces] = await Promise.all([
    loadOrFallback({
      operation: "quality_v2_tool_names",
      distinctId,
      fallback: new Map<string, string>(),
      load: async () =>
        new Map((await loadToolCorpus(projectId)).map((entry) => [entry.entryId, entry.name])),
    }),
    loadOrFallback({
      operation: "quality_v2_trace_links",
      distinctId,
      fallback: new Map<string, string>(),
      load: () => traceLinks(projectId, evidence, window),
    }),
  ]);
  const root = projectRoot(projectId);
  const telemetry = evidence.source.kind === "telemetry";
  const rewrites = rewriteStatusByTool(proposals);
  return toMissRows(evidence.groups, {
    name: (id) => names.get(id) ?? id,
    traceHref: (group) => {
      const traceId = traces.get(group.id);
      return traceId ? `${root}/traces/${encodeURIComponent(traceId)}` : null;
    },
    // A calibration selection reopens by its ids, rankings and all; a plain
    // search by its words, put in the address only on click.
    test: (group) =>
      searchTest({
        query: group.query,
        selectionId: telemetry ? null : group.id,
        experimentName: telemetry ? null : evidence.experimentName,
      }),
    rewrite: (id) => rewrites.get(id) ?? null,
  });
}

/** Each tool's open rewrite: one waiting beats one already applied. */
export function rewriteStatusByTool(
  proposals: readonly Pick<MatchQualityProposalRow, "entryId" | "status">[],
): Map<string, "pending" | "applied"> {
  const byTool = new Map<string, "pending" | "applied">();
  for (const proposal of proposals) {
    if (proposal.status === "pending") byTool.set(proposal.entryId, "pending");
    else if (proposal.status === "applied" && !byTool.has(proposal.entryId))
      byTool.set(proposal.entryId, "applied");
  }
  return byTool;
}

/** Trace ids for the listed misses' latest sightings, only where the trace was kept. */
async function traceLinks(
  projectId: string,
  evidence: QualityEvidence,
  window: Window,
): Promise<Map<string, string>> {
  const sightings = evidence.groups
    .slice(0, MAX_LISTED_MISSES)
    .map((group) => ({ selectionId: group.id, occurredAt: group.latest.occurredAt }));
  const bySelection =
    evidence.source.kind === "telemetry"
      ? await searchTraceIds(projectId, sightings, window)
      : await experimentTraceIds(projectId, evidence.experimentName, sightings, window);
  const kept = await tracesWithSpans(projectId, [...bySelection.values()]);
  return new Map([...bySelection].filter(([, traceId]) => kept.has(traceId)));
}
