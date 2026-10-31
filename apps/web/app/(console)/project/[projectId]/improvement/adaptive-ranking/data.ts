import { notFound } from "next/navigation";
import type {
  RankingClusterRow,
  RankingDetailsData,
  RankingMetric,
} from "@/components/console/adaptive-ranking/RankingDetails";
import type { RankingGraphView } from "@/components/console/adaptive-ranking/RankingView";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { APP_NAME } from "@/lib/platform/app-config";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  getIntentGraphDetail,
  listIntentGraphRuntimeStatus,
  listIntentGraphSummaries,
  listRecentLearningSources,
} from "@/lib/readings/intent-graph/queries";
import { CLOUD_INTENT_GRAPH_KEY, MAX_INTENT_GRAPH_BYTES } from "@/lib/readings/intent-types/wire";
import {
  BOOST_METRICS,
  type BoostMetric,
  type BoostView,
  buildBoostView,
} from "@/lib/views/adaptive-ranking/boost-view";
import {
  firstBoostFromGraphAt,
  listBoostingGraphKeysSince,
  loadBoostSelections,
  loadOutcomesAroundLive,
} from "@/lib/views/adaptive-ranking/queries";
import {
  type ChecklistStep,
  graphGrowth,
  rankingChecklist,
  rankingCurve,
  rankingHeadline,
  rankingMetrics,
  servingState,
} from "@/lib/views/adaptive-ranking/ranking";
import {
  buildBoostWarning,
  buildGraphSteps,
  buildLiveRecall,
  buildProjectSteps,
  type SetupStep,
  STALE_GRAPH_MS,
} from "@/lib/views/adaptive-ranking/setup";
import {
  buildClusterTableRows,
  cloudGraphState,
  formatBytes,
  modelLabel,
} from "@/lib/views/intents/adaptive-view";
import {
  absoluteTime,
  askGroupLabel,
  type GraphChoice,
  graphChoices,
  pickGraph,
  timeAgo,
} from "@/lib/views/intents/map/labels";

/** A runtime that boosted from a graph within this window counts it as boosting (same as v1). */
const ONLINE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Ask groups listed under Details; Intents lists every one. */
const DETAIL_CLUSTERS = 50;

const STEP_TITLES: Record<SetupStep["key"], string> = {
  events: "Send searches and tool calls",
  building: `${APP_NAME} builds the intent map`,
  connected: "Rank from the graph in your runtime",
  following: "Keep up with new revisions",
};

/** The v1 steps in the v2 words: titles as actions, and "ask groups" for clusters. */
function toChecklistInput(step: SetupStep) {
  return {
    key: step.key,
    label: STEP_TITLES[step.key],
    detail: step.detail.replace(/\bquery (groups?)\b/g, "ask $1"),
    state: step.state,
    ...(step.snippet ? { snippet: step.snippet } : {}),
  };
}

/** Before any graph exists the last two steps have nothing to check yet. */
const WAITING_STEPS: SetupStep[] = [
  {
    key: "connected",
    label: STEP_TITLES.connected,
    state: "pending",
    detail:
      "Once the intent map exists, a few lines where your runtime starts make it rank from it. They appear here.",
  },
  {
    key: "following",
    label: STEP_TITLES.following,
    state: "pending",
    detail: `${APP_NAME} then checks that your runtime adopts each new revision as the map learns.`,
  },
];

/**
 * Owned (ADR-0030): the project comes from the console scope, a 404 otherwise.
 */
export type RankingData = {
  projectId: string;
  choices: GraphChoice[];
  defaultKey: string;
  graph: RankingGraphView | null;
  emptyChecklist: ChecklistStep[];
  intentsHref: string;
};

/** What each metric measures, said about the tool the agent ran. */
const MEANING: Record<BoostMetric, string> = {
  "recall@1": "The tool the agent ran came first",
  "recall@3": "It was in the first three",
  "recall@5": "It was in the first five",
  "ndcg@5": "Credit by position: 1 first, 0.63 second, 0 when missing",
  "mrr@5": "The average of 1 over its position",
};

/** Every metric over the same searches as the headline: both lists scored against the tool the agent ran. */
function metricRows(view: BoostView): RankingMetric[] {
  const values = new Map(rankingMetrics(view).map((metric) => [metric.id, metric]));
  return BOOST_METRICS.map((metric) => ({
    id: metric.id,
    label: metric.label,
    meaning: MEANING[metric.id],
    without: values.get(metric.id)?.without ?? null,
    withGraph: values.get(metric.id)?.withGraph ?? null,
    share: metric.id.startsWith("recall"),
  }));
}

/**
 * Everything the Adaptive ranking page reads for one graph: the comparison
 * of rankings with and without it, the graph's own setup steps, and its facts.
 * `graphKey` comes from `?graph=` on the list page, or the path on a graph's
 * own page, where a key that does not exist is a 404.
 */
export async function loadRanking(input: {
  projectId: string;
  graphKey: string | null;
  fromPath: boolean;
}): Promise<RankingData> {
  const { project } = await requireProjectScope(input.projectId);
  const distinctId = `project:${project.id}`;
  const read = <T>(operation: string, fallback: T, load: () => Promise<T>) =>
    loadOrFallback({ operation, distinctId, fallback, load });
  const now = new Date();
  const dayAgo = new Date(now.getTime() - ONLINE_WINDOW_MS);

  const [summaries, boostingKeys, sources, runtimes] = await Promise.all([
    read("intent_graph_summaries", [], () => listIntentGraphSummaries(project.id)),
    read("intent_graph_boosting_keys", new Set<string>(), () =>
      listBoostingGraphKeysSince(project.id, dayAgo),
    ),
    read("intent_graph_learning_sources", [], () => listRecentLearningSources(project.id, dayAgo)),
    read("intent_graph_runtime_status", [], () => listIntentGraphRuntimeStatus(project.id)),
  ]);
  const choices = graphChoices(summaries);
  const defaultKey = pickGraph(choices, null)?.graphKey ?? CLOUD_INTENT_GRAPH_KEY;
  const choice = input.fromPath
    ? (choices.find((item) => item.graphKey === input.graphKey) ?? null)
    : pickGraph(choices, input.graphKey);
  if (input.fromPath && !choice) notFound();
  const intentsRoot = `/project/${encodeURIComponent(project.id)}/intents`;
  const cloudRows = summaries.filter((row) => row.producer === "cloud");
  const projectSteps = buildProjectSteps({ sources, graphs: cloudRows });
  const emptyChecklist = rankingChecklist(
    [...projectSteps.steps, ...WAITING_STEPS].map(toChecklistInput),
  );
  const base = { projectId: project.id, choices, defaultKey, emptyChecklist };
  if (!choice) return { ...base, graph: null, intentsHref: intentsRoot };

  const summary = summaries.find((row) => row.graphKey === choice.graphKey)!;
  const detail = await getIntentGraphDetail(project.id, choice.graphKey);
  if (!detail) {
    if (input.fromPath) notFound();
    return { ...base, graph: null, intentsHref: intentsRoot };
  }
  const liveAt = detail.graph.producer === "cloud" ? detail.graph.liveAt : null;
  const [boostSelections, onlineSince, outcomes] = await Promise.all([
    read("intent_graph_boost", { selections: [], estimated: false, reportedCount: 0 }, () =>
      loadBoostSelections(project.id, choice.graphKey).then((result) => ({
        selections: result.selections,
        estimated: result.estimated,
        reportedCount: result.reportedCount,
      })),
    ),
    read("intent_graph_online_since", null, () =>
      firstBoostFromGraphAt(project.id, choice.graphKey),
    ),
    liveAt === null
      ? Promise.resolve(null)
      : read(
          "intent_graph_outcomes",
          { before: { turns: 0, recallAt5: null }, after: { turns: 0, recallAt5: null } },
          () => loadOutcomesAroundLive(project.id, choice.graphKey, liveAt),
        ),
  ]);
  const boost = buildBoostView(boostSelections.selections, {
    onlineSince: boostSelections.estimated ? null : onlineSince,
    estimated: boostSelections.estimated,
    reported: boostSelections.reportedCount > 0,
  });
  const serving = servingState(
    detail.graph.producer,
    detail.graph.producer === "cloud"
      ? cloudGraphState({ liveAt, boosting: boostingKeys.has(choice.graphKey) })
      : null,
  );
  const headline = rankingHeadline(boost, serving.served);

  const graphSteps =
    detail.graph.producer === "cloud"
      ? buildGraphSteps({
          graph: {
            graphKey: choice.graphKey,
            rev: detail.graph.rev,
            updatedAt: detail.graph.updatedAt,
          },
          runtimes,
          now,
        })
      : null;

  const warnings: string[] = [];
  const missingTools = [...detail.missingCapabilities]
    .filter((key) => key.startsWith("tool:"))
    .map((key) => key.slice(5));
  if (missingTools.length > 0) {
    warnings.push(
      `It lifts ${missingTools.length === 1 ? "a tool that is" : `${missingTools.length} tools that are`} no longer in your catalog (${missingTools.join(", ")}). The agent cannot call ${missingTools.length === 1 ? "it" : "them"}; they leave the graph as new traffic replaces them.`,
    );
  }
  const lastEventAt = sources.reduce<Date | null>(
    (latest, source) => (latest === null || source.lastAt > latest ? source.lastAt : latest),
    null,
  );
  if (
    detail.graph.producer === "cloud" &&
    lastEventAt !== null &&
    lastEventAt.getTime() - detail.graph.updatedAt.getTime() > STALE_GRAPH_MS
  ) {
    warnings.push(
      "The graph has not caught up with recent searches. Events are arriving but it stopped updating; tell us if this persists.",
    );
  }
  const boostWarning = buildBoostWarning(
    boost.online.fromTurn !== null ? boost.phases["ndcg@5"].online.verdict : boost.verdict,
  );
  if (boostWarning) warnings.push(boostWarning);

  const liveRecall = outcomes === null ? null : buildLiveRecall(outcomes);
  const rows = buildClusterTableRows(detail.clusters, detail.edges, detail.missingCapabilities);
  const clusters: RankingClusterRow[] = rows.slice(0, DETAIL_CLUSTERS).map((row) => ({
    id: row.clusterId,
    label: askGroupLabel({ label: row.displayLabel, terms: row.terms }),
    support: row.support,
    phrasings: row.memberCount,
    topTool: row.topTool?.id ?? row.topSkill?.id ?? null,
    lastSeen: row.lastTs ? timeAgo(row.lastTs, now) : "Never",
  }));
  const details: RankingDetailsData = {
    searches: headline.searches,
    estimated: boost.estimated,
    metrics: metricRows(boost),
    verdict: boost.online.fromTurn !== null ? boost.phases["ndcg@5"].online.verdict : boost.verdict,
    liveRecall: liveRecall ? { before: liveRecall.before, after: liveRecall.after } : null,
    facts: [
      { label: "Revision", value: detail.graph.rev.toLocaleString("en-US") },
      {
        label: "Matching",
        value: detail.graph.model ? modelLabel(detail.graph.model) : "Keyword match",
      },
      {
        label: "Size",
        value: `${formatBytes(detail.graph.byteSize)} of ${formatBytes(MAX_INTENT_GRAPH_BYTES)}`,
      },
      { label: "Updated", value: absoluteTime(detail.graph.updatedAt) },
    ],
    clusters,
    clusterTotal: rows.length,
  };

  return {
    ...base,
    intentsHref:
      choice.graphKey === defaultKey
        ? intentsRoot
        : `${intentsRoot}?graph=${encodeURIComponent(choice.graphKey)}`,
    graph: {
      choice,
      serving,
      headline,
      curve: rankingCurve(boost),
      growth: graphGrowth({
        maturity: summary.maturity,
        clusterCount: detail.graph.clusterCount,
        byteSize: detail.graph.byteSize,
      }),
      checklist:
        graphSteps && !graphSteps.allDone
          ? rankingChecklist(graphSteps.steps.map(toChecklistInput))
          : null,
      warnings,
      details,
    },
  };
}
