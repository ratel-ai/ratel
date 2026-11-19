import { z } from "zod";
import { notFound } from "@/lib/mcp/errors";
import { mcpActor } from "@/lib/mcp/operations/health";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { capRows, round, TruncationTracker } from "@/lib/mcp/serialize";
import { serviceName } from "@/lib/platform/app-config";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  type CatalogDrift,
  missingCapabilityKeys,
} from "@/lib/readings/intent-graph/catalog-drift";
import {
  catalogDriftEnabledForActor,
  loadCatalogDrift,
} from "@/lib/readings/intent-graph/catalog-drift-queries";
import {
  getIntentGraphDetail,
  type IntentGraphDetail,
  type IntentGraphSummaryRow,
  type LearningSource,
  listIntentGraphRuntimeStatus,
  listIntentGraphSummaries,
  listRecentLearningSources,
} from "@/lib/readings/intent-graph/queries";
import { CLOUD_INTENT_GRAPH_KEY, MAX_INTENT_GRAPH_BYTES } from "@/lib/readings/intent-types/wire";
import { BOOST_METRICS, buildBoostView } from "@/lib/views/adaptive-ranking/boost-view";
import {
  firstBoostFromGraphAt,
  listBoostingGraphKeysSince,
  loadBoostSelections,
  loadOutcomesAroundLive,
  type RuntimeOutcomes,
} from "@/lib/views/adaptive-ranking/queries";
import {
  type ChecklistStep,
  graphGrowth,
  rankingChecklist,
  rankingHeadline,
  rankingMetrics,
  rankingVerdict,
  rankingWarningItems,
  rankingWarnings,
  servingState,
  toChecklistInput,
  WAITING_STEPS,
  warningText,
} from "@/lib/views/adaptive-ranking/ranking";
import {
  buildGraphSteps,
  buildLiveRecall,
  buildProjectSteps,
  type RuntimeStatusFact,
} from "@/lib/views/adaptive-ranking/setup";
import {
  buildClusterTableRows,
  cloudGraphState,
  formatBytes,
  modelLabel,
} from "@/lib/views/intents/adaptive-view";
import { askGroupLabel, graphChoices, pickGraph } from "@/lib/views/intents/map/labels";

/**
 * Improve › Adaptive ranking over MCP: which intent graphs the project has,
 * whether a runtime ranks from each, and whether ranking from it finds the
 * right tool first more often than without it.
 *
 * Every number is the console's: the same Boost view, headline and metrics
 * over the same matched searches, the same warnings and setup steps. The
 * supplementary reads degrade the way the page's do, so one slow query costs
 * a field rather than the answer.
 *
 * Ask group labels are drawn from end users' asks, so they are truncated, and
 * only the busiest groups are listed.
 */

/** A runtime that boosted from a graph within this window counts it as boosting (same as the page). */
const ONLINE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOP_CLUSTERS = 25;
const LABEL_CHARS = 120;
const SNIPPET_CHARS = 1_500;

export interface RankingOperationDeps {
  listIntentGraphSummaries: (projectId: string) => Promise<IntentGraphSummaryRow[]>;
  listBoostingGraphKeysSince: (projectId: string, since: Date) => Promise<Set<string>>;
  listRecentLearningSources: (projectId: string, since: Date) => Promise<LearningSource[]>;
  listIntentGraphRuntimeStatus: (projectId: string) => Promise<RuntimeStatusFact[]>;
  getIntentGraphDetail: (projectId: string, graphKey: string) => Promise<IntentGraphDetail | null>;
  loadBoostSelections: typeof loadBoostSelections;
  firstBoostFromGraphAt: (projectId: string, graphKey: string) => Promise<Date | null>;
  loadOutcomesAroundLive: (
    projectId: string,
    graphKey: string,
    liveAt: Date,
  ) => Promise<{ before: RuntimeOutcomes; after: RuntimeOutcomes }>;
  /** `cloud-ranking-catalog-drift` for the caller in the project's organization; absent reads as off. */
  catalogDriftEnabled?: (projectId: string, actor: string) => Promise<boolean>;
  /** The gone-tool rule over the graph's tools (RC-722). */
  loadCatalogDrift?: (projectId: string, toolIds: string[], now: Date) => Promise<CatalogDrift>;
  now?: () => Date;
}

export const defaultRankingDeps: RankingOperationDeps = {
  listIntentGraphSummaries: (projectId) => listIntentGraphSummaries(projectId),
  listBoostingGraphKeysSince: (projectId, since) => listBoostingGraphKeysSince(projectId, since),
  listRecentLearningSources: (projectId, since) => listRecentLearningSources(projectId, since),
  listIntentGraphRuntimeStatus: (projectId) => listIntentGraphRuntimeStatus(projectId),
  getIntentGraphDetail: (projectId, graphKey) => getIntentGraphDetail(projectId, graphKey),
  loadBoostSelections,
  firstBoostFromGraphAt: (projectId, graphKey) => firstBoostFromGraphAt(projectId, graphKey),
  loadOutcomesAroundLive: (projectId, graphKey, liveAt) =>
    loadOutcomesAroundLive(projectId, graphKey, liveAt),
  catalogDriftEnabled: (projectId, actor) => catalogDriftEnabledForActor(projectId, actor),
  loadCatalogDrift: (projectId, toolIds, now) => loadCatalogDrift(projectId, toolIds, now),
};

function checklistView(steps: readonly ChecklistStep[], tracker: TruncationTracker) {
  return steps.map((step) => ({
    key: step.key,
    title: step.title,
    state: step.state,
    detail: step.detail,
    ...(step.snippet ? { snippet: tracker.text(step.snippet, SNIPPET_CHARS) } : {}),
  }));
}

/** The project-level reads both tools start from, each degrading on its own as the page's do. */
async function projectReads(deps: RankingOperationDeps, projectId: string, now: Date) {
  const distinctId = `project:${projectId}`;
  const dayAgo = new Date(now.getTime() - ONLINE_WINDOW_MS);
  const [summaries, boostingKeys, sources, runtimes] = await Promise.all([
    // The list is the answer itself: a failure here is a failure, not an empty project.
    deps.listIntentGraphSummaries(projectId),
    loadOrFallback({
      operation: "mcp_intent_graph_boosting_keys",
      distinctId,
      fallback: new Set<string>(),
      load: () => deps.listBoostingGraphKeysSince(projectId, dayAgo),
    }),
    loadOrFallback({
      operation: "mcp_intent_graph_learning_sources",
      distinctId,
      fallback: [] as LearningSource[],
      load: () => deps.listRecentLearningSources(projectId, dayAgo),
    }),
    loadOrFallback({
      operation: "mcp_intent_graph_runtime_status",
      distinctId,
      fallback: [] as RuntimeStatusFact[],
      load: () => deps.listIntentGraphRuntimeStatus(projectId),
    }),
  ]);
  return { summaries, boostingKeys, sources, runtimes };
}

function projectChecklist(
  summaries: readonly IntentGraphSummaryRow[],
  sources: readonly LearningSource[],
): ChecklistStep[] {
  const cloud = summaries.filter((row) => row.producer === "cloud");
  const steps = buildProjectSteps({ sources, graphs: cloud });
  return rankingChecklist([...steps.steps, ...WAITING_STEPS].map(toChecklistInput));
}

const graphKeyParam = z
  .string()
  .min(1)
  .max(200)
  .describe(`A graphKey from list_ranking_graphs. Omit for the merged ${serviceName()} graph.`);

export function rankingOperations(deps: RankingOperationDeps = defaultRankingDeps): McpOperation[] {
  const now = () => deps.now?.() ?? new Date();

  return [
    defineOperation({
      id: "list_ranking_graphs",
      domain: "improvement",
      title: "Adaptive ranking: graphs",
      description:
        "The project's intent graphs for adaptive ranking: who built each, whether a runtime ranks from it, revision, size and how much it has learned, plus the setup steps still open. Open one with get_ranking_graph to see whether it helps.",
      keywords: [
        "adaptive ranking",
        "intent graph",
        "boost",
        "ranking",
        "learned ranking",
        "setup",
      ],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const at = now();
        const tracker = new TruncationTracker();
        const { summaries, boostingKeys, sources } = await projectReads(deps, ctx.projectId, at);
        const choices = graphChoices(summaries);
        const byKey = new Map(summaries.map((row) => [row.graphKey, row]));
        const defaultKey = pickGraph(choices, null)?.graphKey ?? CLOUD_INTENT_GRAPH_KEY;
        const graphs = choices.map((choice) => {
          const row = byKey.get(choice.graphKey)!;
          const serving = servingState(
            row.producer,
            row.producer === "cloud"
              ? cloudGraphState({ liveAt: row.liveAt, boosting: boostingKeys.has(row.graphKey) })
              : null,
          );
          return {
            graphKey: choice.graphKey,
            label: choice.label,
            origin: choice.origin,
            serving: serving.label,
            served: serving.served,
            rev: row.rev,
            matching: row.model ? modelLabel(row.model) : "Keyword match",
            askGroups: row.clusterCount,
            learned: round(
              graphGrowth({
                maturity: row.maturity,
                clusterCount: row.clusterCount,
                byteSize: row.byteSize,
              }).learned,
              2,
            ),
            size: formatBytes(row.byteSize),
            updatedAt: row.updatedAt.toISOString(),
            pulledAt: row.pulledAt?.toISOString() ?? null,
            liveAt: row.liveAt?.toISOString() ?? null,
          };
        });
        const checklist = projectChecklist(summaries, sources);
        return {
          data: {
            count: graphs.length,
            defaultGraphKey: graphs.length > 0 ? defaultKey : null,
            graphs,
            setup: checklistView(checklist, tracker),
          },
          truncated: tracker.value,
          hint:
            graphs.length > 0
              ? "Call get_ranking_graph with a graphKey for its with-and-without comparison, warnings and setup."
              : `No graph yet. Follow the setup steps: ${serviceName()} builds one once searches and tool calls arrive.`,
        };
      },
    }),
    defineOperation({
      id: "get_ranking_graph",
      domain: "improvement",
      title: "Adaptive ranking: one graph",
      description:
        "Whether one intent graph helps: serving state, how often the right tool comes first with and without it, recall@1/3/5, nDCG@5 and MRR@5 both ways, the verdict, live recall before and after, warnings, facts, its busiest ask groups and the setup steps left.",
      keywords: [
        "adaptive ranking",
        "intent graph",
        "does it help",
        "recall",
        "ndcg",
        "mrr",
        "boost",
      ],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, graphKey: graphKeyParam.optional() }),
      async execute(ctx, params) {
        const at = now();
        const distinctId = `project:${ctx.projectId}`;
        const tracker = new TruncationTracker();
        const { summaries, boostingKeys, sources, runtimes } = await projectReads(
          deps,
          ctx.projectId,
          at,
        );
        const choices = graphChoices(summaries);
        const choice = params.graphKey
          ? (choices.find((item) => item.graphKey === params.graphKey) ?? null)
          : pickGraph(choices, null);
        if (!choice) {
          if (params.graphKey) throw notFound("intent graph");
          return {
            data: {
              graph: null,
              setup: checklistView(projectChecklist(summaries, sources), tracker),
            },
            truncated: tracker.value,
            hint: "This project has no intent graph yet. Follow the setup steps.",
          };
        }

        const summary = summaries.find((row) => row.graphKey === choice.graphKey)!;
        const detail = await deps.getIntentGraphDetail(ctx.projectId, choice.graphKey);
        if (!detail) throw notFound("intent graph");
        const liveAt = detail.graph.producer === "cloud" ? detail.graph.liveAt : null;
        const toolIds = [
          ...new Set(
            detail.edges.filter((edge) => edge.kind === "tool").map((edge) => edge.capabilityId),
          ),
        ];
        const driftOn = await loadOrFallback({
          operation: "mcp_intent_graph_catalog_drift_flag",
          distinctId,
          fallback: false,
          load: async () =>
            deps.catalogDriftEnabled
              ? deps.catalogDriftEnabled(ctx.projectId, mcpActor(ctx.auth, ctx.projectId))
              : false,
        });
        const [boostSelections, onlineSince, outcomes, drift] = await Promise.all([
          loadOrFallback({
            operation: "mcp_intent_graph_boost",
            distinctId,
            fallback: { selections: [], estimated: false, reportedCount: 0 },
            load: () =>
              deps.loadBoostSelections(ctx.projectId, choice.graphKey).then((result) => ({
                selections: result.selections,
                estimated: result.estimated,
                reportedCount: result.reportedCount,
              })),
          }),
          loadOrFallback({
            operation: "mcp_intent_graph_online_since",
            distinctId,
            fallback: null,
            load: () => deps.firstBoostFromGraphAt(ctx.projectId, choice.graphKey),
          }),
          liveAt === null
            ? Promise.resolve(null)
            : loadOrFallback({
                operation: "mcp_intent_graph_outcomes",
                distinctId,
                fallback: {
                  before: { turns: 0, recallAt5: null },
                  after: { turns: 0, recallAt5: null },
                },
                load: () => deps.loadOutcomesAroundLive(ctx.projectId, choice.graphKey, liveAt),
              }),
          // A failed read says nothing rather than calling every tool gone or the catalog absent.
          driftOn && deps.loadCatalogDrift
            ? loadOrFallback<CatalogDrift>({
                operation: "mcp_intent_graph_catalog_drift",
                distinctId,
                fallback: { hasCatalog: true, gone: new Set() },
                load: () => deps.loadCatalogDrift!(ctx.projectId, toolIds, at),
              })
            : Promise.resolve(null),
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
        const lastEventAt = sources.reduce<Date | null>(
          (latest, source) => (latest === null || source.lastAt > latest ? source.lastAt : latest),
          null,
        );
        const missing = drift
          ? missingCapabilityKeys(detail.missingCapabilities, drift)
          : detail.missingCapabilities;
        // With the drift flag on, a gone-tool warning names a few tools and counts the rest (RC-723).
        const warnings = drift
          ? rankingWarningItems({
              producer: detail.graph.producer,
              updatedAt: detail.graph.updatedAt,
              drift,
              hasToolEdges: toolIds.length > 0,
              lastEventAt,
              view: boost,
            }).map((warning) => warningText(warning))
          : rankingWarnings({
              producer: detail.graph.producer,
              updatedAt: detail.graph.updatedAt,
              missingCapabilities: detail.missingCapabilities,
              lastEventAt,
              view: boost,
            });
        const graphSteps =
          detail.graph.producer === "cloud"
            ? buildGraphSteps({
                graph: {
                  graphKey: choice.graphKey,
                  rev: detail.graph.rev,
                  updatedAt: detail.graph.updatedAt,
                },
                runtimes,
                now: at,
              })
            : null;
        const liveRecall = outcomes === null ? null : buildLiveRecall(outcomes);
        const rows = buildClusterTableRows(detail.clusters, detail.edges, missing);
        const clusters = tracker.take(capRows(rows, TOP_CLUSTERS));
        const metrics = new Map(rankingMetrics(boost).map((metric) => [metric.id, metric]));
        const growth = graphGrowth({
          maturity: summary.maturity,
          clusterCount: detail.graph.clusterCount,
          byteSize: detail.graph.byteSize,
        });

        return {
          data: {
            graphKey: choice.graphKey,
            label: choice.label,
            origin: choice.origin,
            serving: { label: serving.label, sentence: serving.sentence, served: serving.served },
            headline: {
              state: headline.state,
              title: headline.title,
              detail: headline.detail,
              withGraph: round(headline.withGraph),
              without: round(headline.without),
              points: headline.points,
              relative: round(headline.relative),
              searches: headline.searches,
              seen: headline.seen,
              projected: headline.projected,
              estimated: headline.estimated,
              notes: headline.notes,
            },
            // Over the same matched searches as the headline, so the two never disagree.
            metrics: BOOST_METRICS.map((metric) => ({
              id: metric.id,
              label: metric.label,
              without: round(metrics.get(metric.id)?.without ?? null),
              withGraph: round(metrics.get(metric.id)?.withGraph ?? null),
            })),
            verdict: rankingVerdict(boost),
            liveRecall: liveRecall
              ? {
                  before: round(liveRecall.before),
                  after: round(liveRecall.after),
                  improved: liveRecall.improved,
                }
              : null,
            growth: {
              learned: round(growth.learned, 2),
              used: round(growth.used, 2),
              usedLabel: growth.usedLabel,
            },
            warnings,
            facts: {
              revision: detail.graph.rev,
              matching: detail.graph.model ? modelLabel(detail.graph.model) : "Keyword match",
              size: `${formatBytes(detail.graph.byteSize)} of ${formatBytes(MAX_INTENT_GRAPH_BYTES)}`,
              updatedAt: detail.graph.updatedAt.toISOString(),
            },
            askGroupCount: rows.length,
            topAskGroups: clusters.map((row) => ({
              id: row.clusterId,
              label: tracker.text(
                askGroupLabel({ label: row.displayLabel, terms: row.terms }),
                LABEL_CHARS,
              ),
              support: row.support,
              phrasings: row.memberCount,
              topTool: row.topTool?.id ?? row.topSkill?.id ?? null,
              topToolMissing: (row.topTool ?? row.topSkill)?.missing ?? false,
              lastSeen: row.lastTs?.toISOString() ?? null,
            })),
            setup:
              graphSteps && !graphSteps.allDone
                ? checklistView(rankingChecklist(graphSteps.steps.map(toChecklistInput)), tracker)
                : [],
          },
          truncated: tracker.value,
          hint: warnings.length
            ? "Read the warnings first: they say what to change in the runtime or the catalog."
            : serving.served
              ? "Served. list_ranking_graphs lists the other graphs to compare."
              : "Not served yet: the numbers are what ranking from it would do. The setup steps say how to switch a runtime to it.",
        };
      },
    }),
  ];
}
