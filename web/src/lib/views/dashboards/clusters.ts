import type { ClustersQuery } from "@/lib/contracts/query";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import type { ClusterNames, ClustersResult } from "@/lib/synthesis/metrics/clusters";
import { metricSeams } from "@/lib/synthesis/metrics/query";
import type { IntentMapModel } from "@/lib/views/intents/map/map-model";
import { loadToolSteps } from "@/lib/views/intents/map/queries";
import type { ToolStep } from "@/lib/views/intents/map/tool-network";
import { topicMapModel } from "@/lib/views/intents/topics-map-model";
import { readTopics } from "@/lib/views/intents/topics-read";

/**
 * The clusters kind: a part of the stored intent map. It reads no trace, so neither the time range
 * nor the dashboard's filters narrow it. Import this module for its effect where `runQuery` may
 * read it.
 */

export type DashboardClusters = ClustersResult<IntentMapModel, ToolStep>;

const EMPTY_MODEL: IntentMapModel = { asks: [], capabilities: [], links: [], hidden: null };

export async function runClusters(
  projectId: string,
  query: ClustersQuery,
  db: BoundReadDb,
): Promise<DashboardClusters> {
  const read = await readTopics(projectId, db);
  const whole = read ? topicMapModel(read.view, read.insights.tools) : EMPTY_MODEL;
  const model = selectClusters(whole, query);
  const keep = new Set(model.capabilities.map(({ id }) => id));
  const steps =
    query.view === "tools" && keep.size > 1 ? await loadToolSteps({ projectId, keep }, db) : [];
  return {
    kind: "clusters",
    view: query.view,
    model,
    steps,
    analyzedAt: read?.computedAt.toISOString() ?? null,
    names: namesOf(whole),
  };
}

/**
 * The part of the map a subset names. Values of one property are alternatives; properties combine.
 * A cluster stays when it has a kept tool or skill; a tool when a kept cluster called it.
 */
export function selectClusters(model: IntentMapModel, subset: ClusterSubset): IntentMapModel {
  const { minSize = 0 } = subset;
  const clusters = nameSet(subset.clusters);
  const tools = nameSet(subset.tools);
  const skills = nameSet(subset.skills);
  const tasks = nameSet(subset.tasks);
  const taskNames = new Map((model.tasks ?? []).map(({ id, name }) => [id, name]));
  const byCapability = tools.size > 0 || skills.size > 0 || tasks.size > 0;
  const named = (kind: string, name: string) =>
    (tools.size === 0 && skills.size === 0) || (kind === "tool" ? tools : skills).has(normal(name));
  const capable = new Set(
    model.capabilities
      .filter(
        ({ kind, name, task }) =>
          named(kind, name) &&
          (tasks.size === 0 || tasks.has(normal(taskNames.get(task ?? "") ?? ""))),
      )
      .map(({ id }) => id),
  );
  const sized = new Set(
    model.asks
      .filter(
        ({ label, volume }) =>
          volume >= minSize && (clusters.size === 0 || clusters.has(normal(label))),
      )
      .map(({ id }) => id),
  );
  const links = model.links.filter(
    ({ ask, capability }) => sized.has(ask) && capable.has(capability),
  );
  const linkedAsks = new Set(links.map(({ ask }) => ask));
  const asks = model.asks.filter(({ id }) => (byCapability ? linkedAsks : sized).has(id));
  const linkedCapabilities = new Set(links.map(({ capability }) => capability));
  const capabilities = model.capabilities
    .filter(({ id }) => linkedCapabilities.has(id))
    .map((capability) => {
      const own = links.filter(({ capability: id }) => id === capability.id);
      return {
        ...capability,
        calls: own.reduce((sum, { weight }) => sum + weight, 0),
        asks: own.length,
      };
    })
    .sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id));
  return { ...model, asks, capabilities, links };
}

type ClusterSubset = Pick<ClustersQuery, "clusters" | "tools" | "skills" | "tasks" | "minSize">;

function namesOf({ asks, capabilities, tasks = [] }: IntentMapModel): ClusterNames {
  const of = (kind: string) =>
    capabilities.filter((capability) => capability.kind === kind).map(({ name }) => name);
  return {
    clusters: unique(asks.map(({ label }) => label)),
    tools: unique(of("tool")),
    skills: unique(of("skill")),
    tasks: unique(tasks.map(({ name }) => name)),
  };
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : 1));
}

function nameSet(names: readonly string[] = []): ReadonlySet<string> {
  return new Set(names.map(normal));
}

function normal(name: string): string {
  return name.trim().toLowerCase();
}

// The dashboards read with the whole bounded connection; the seam names only what the catalog needs.
metricSeams.clusters = (projectId, query, _scope, db) =>
  runClusters(projectId, query, db as unknown as BoundReadDb);
