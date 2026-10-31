import { type BoundReadDb, withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadCatalogNames } from "@/lib/readings/trace-signals/signals/analysis-context";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import {
  buildSelfCorrectionsPage,
  type StatView,
  type TrendView,
  trendBucketDays,
} from "@/lib/views/health/self-corrections/page-model";
import {
  countByBucket,
  countCorrections,
  countFailedCalls,
  countTurns,
  groupCorrections,
  loadCorrectionRun,
  type PageRange,
} from "@/lib/views/health/self-corrections/page-queries";
import { NO_FILTERS, selfCorrectionsHref } from "@/lib/views/health/self-corrections/paths";

/**
 * Self-corrections on the Agent health Summary, its headline only: the rate
 * per 100 turns with its change against the window before and its trend,
 * the share of failed calls the agent got past, the tool it corrects itself
 * after most, the phrase it says most, and the way to the page (which
 * explains). A lean read: the counts the row shows and nothing else.
 */

export interface SelfCorrectionsCardModel {
  state: "not_read" | "mixed_runs" | "no_turns" | "ready" | "unavailable";
  windowDays: WindowDays;
  /** The page's "Per 100 turns" stat, delta included when the window before is covered. */
  rate: StatView;
  events: number;
  turns: number;
  /** The tool the agent corrects itself after most; `href` is the page narrowed to it. */
  topTool: {
    node: string;
    entryId: string;
    entryKind: "tool" | "skill";
    name: string;
    events: number;
    mainKind: string;
    href: string;
  } | null;
  href: string;
  /** Per 100 turns over the window; null before it can be drawn. */
  trend: TrendView | null;
  /** The page's "Recovered" stat: the failed calls a later call in the turn got past. */
  recovered: StatView | null;
  /** The same as a share, for its meter; null when no call failed. */
  recoveredShare: number | null;
  /** The phrase the agent said most, when its replies were captured. */
  topPhrase: { phrase: string; events: number } | null;
  /** Whether the agent's replies were read at all (content capture is on). */
  phrasesCaptured: boolean;
}

const DAY_MS = 86_400_000;
const NO_RATE: StatView = { label: "Per 100 turns", value: "0.0", hint: "" };

function emptyCard(
  state: SelfCorrectionsCardModel["state"],
  projectId: string,
  windowDays: WindowDays,
): SelfCorrectionsCardModel {
  return {
    state,
    windowDays,
    rate: NO_RATE,
    events: 0,
    turns: 0,
    topTool: null,
    href: selfCorrectionsHref(projectId, { days: windowDays }),
    trend: null,
    recovered: null,
    recoveredShare: null,
    topPhrase: null,
    phrasesCaptured: false,
  };
}

export async function readSelfCorrectionsCard(
  db: BoundReadDb,
  projectId: string,
  windowDays: WindowDays,
  now: Date = new Date(),
): Promise<SelfCorrectionsCardModel> {
  const run = await loadCorrectionRun(db, projectId);
  if (!run) return emptyCard("not_read", projectId, windowDays);
  const end = run.windowEnd.getTime() < now.getTime() ? run.windowEnd : now;
  const current: PageRange = { from: new Date(end.getTime() - windowDays * DAY_MS), to: end };
  const before: PageRange = {
    from: new Date(current.from.getTime() - windowDays * DAY_MS),
    to: current.from,
  };
  const trust = run.stored.trust;
  const covered = run.coveredFrom !== null && run.coveredFrom.getTime() <= before.from.getTime();
  // One connection inside the bounded read: the reads run one after another.
  const turns = await countTurns(db, projectId, current, NO_FILTERS, trust);
  const groups = await groupCorrections(db, projectId, current, NO_FILTERS, trust);
  const failed = await countFailedCalls(db, projectId, current, NO_FILTERS, trust);
  const buckets = await countByBucket(
    db,
    projectId,
    current,
    NO_FILTERS,
    trust,
    trendBucketDays(windowDays),
  );
  const previous = covered
    ? {
        turns: await countTurns(db, projectId, before, NO_FILTERS, trust),
        events: await countCorrections(db, projectId, before, NO_FILTERS, trust),
      }
    : null;
  const tools = await loadCatalogNames(projectId, db);
  const page = buildSelfCorrectionsPage({
    projectId,
    windowDays,
    filters: NO_FILTERS,
    names: { tools, tasks: new Map(), topics: new Map() },
    reads: {
      run: {
        computedAt: (run.finishedAt ?? run.windowEnd).toISOString(),
        trust,
        turnsWithReplies: run.stored.turnsWithReplies,
      },
      current: { turns, groups, failedCalls: failed.failed, recoveredCalls: failed.recovered },
      buckets,
      previous,
      taskTurns: new Map(),
      topicTurns: new Map(),
      examples: [],
      issues: [],
      sentiment: null,
    },
  });
  const top = page.byTool[0];
  const phrase = page.phrases.top[0];
  return {
    state: page.state === "unavailable" ? "unavailable" : page.state,
    windowDays,
    rate: page.stats[0] ?? NO_RATE,
    events: page.events,
    turns: page.turns,
    topTool: top
      ? {
          node: top.node,
          entryId: top.entryId,
          entryKind: top.entryKind,
          name: top.name,
          events: top.events,
          mainKind: top.mainKind,
          href: top.filterHref,
        }
      : null,
    href: selfCorrectionsHref(projectId, { days: windowDays }),
    trend: page.trend,
    recovered: page.stats[1] ?? null,
    recoveredShare: failed.failed > 0 ? failed.recovered / failed.failed : null,
    topPhrase: phrase ? { phrase: phrase.phrase, events: phrase.events } : null,
    phrasesCaptured: page.phrases.captured,
  };
}

/** The card's read under the statement timeout; throws on failure (wrap it in `loadOrFallback`). */
export function loadSelfCorrectionsCard(
  projectId: string,
  windowDays: WindowDays,
  db?: BoundReadDb,
): Promise<SelfCorrectionsCardModel> {
  return withStatementTimeout((tx) => readSelfCorrectionsCard(tx, projectId, windowDays), {
    operation: "self_corrections_card",
    ...(db ? { db } : {}),
  });
}

/** The card when its read failed. */
export function unavailableSelfCorrectionsCard(
  projectId: string,
  windowDays: WindowDays,
): SelfCorrectionsCardModel {
  return emptyCard("unavailable", projectId, windowDays);
}
