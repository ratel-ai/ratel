import {
  CLOUD_INTENT_GRAPH_KEY,
  cloudGraphSource,
  cloudSourceGraphKey,
  isCloudGraphKey,
} from "@/lib/readings/intent-types/wire";

/**
 * Where a project, and then each Cloud-built graph, stands on the way to
 * adaptive ranking from Cloud, as steps a customer can act on. Pure: the page
 * gathers the facts, this decides what to say. Every step is `done`, `pending` (nothing wrong, not there yet) or
 * `problem` (something the customer should change), with the fix beside it.
 *
 * The integration is fixed: two SDKs and telemetry. What Cloud can do is see
 * which of its parts is missing and hand over the exact lines. Ranking from a
 * Cloud graph is started in the customer's code, never from here: a graph is
 * live once a runtime reports it ranks from it.
 */

export type SetupStepKey = "events" | "building" | "connected" | "following";
export type SetupStepState = "done" | "pending" | "problem";

export interface SetupStep {
  key: SetupStepKey;
  label: string;
  state: SetupStepState;
  detail: string;
  /** Code to paste, when the step needs a change in the runtime. */
  snippet?: string;
}

export interface SetupSteps {
  steps: SetupStep[];
  allDone: boolean;
}

/** A runtime's last reported ranking status. */
export interface RuntimeStatusFact {
  sourceId: string;
  status: string;
  graphKey: string | null;
  learn: boolean;
  rev: number | null;
  observedAt: Date;
}

/** What the list page knows: whether the project feeds Cloud, and what Cloud built from it. */
export interface ProjectSetupFacts {
  /**
   * Learning events per source over the last day, busiest first: a runtime's
   * searches and tool calls, or an agent's asks and tool calls over
   * OpenTelemetry, where `silentCalls` are its model calls that carried no ask.
   */
  sources: ReadonlyArray<{
    sourceId: string;
    lane: "runtime" | "otlp";
    searches: number;
    invokes: number;
    silentCalls: number;
  }>;
  /** Cloud-built graphs. */
  graphs: ReadonlyArray<{ graphKey: string; rev: number; clusterCount: number }>;
}

/** What one Cloud graph's page knows: who ranks from it. */
export interface GraphSetupFacts {
  graph: { graphKey: string; rev: number; updatedAt: Date };
  /** Every runtime's last reported ranking status; the graph picks its own. */
  runtimes: ReadonlyArray<RuntimeStatusFact>;
  now: Date;
}

/** A consumer polls every five minutes by default; two missed polls is a runtime that is not adopting. */
export const FOLLOW_GRACE_MS = 10 * 60_000;

/**
 * The lines that connect a runtime to the graph Cloud builds for it, in the
 * order that works. The merged graph is consumed under its own key.
 */
export function connectSnippet(
  sourceId: string,
  graphKey: string = cloudSourceGraphKey(sourceId),
): string {
  return `import { attach, attachIntentGraphSync } from "@ratel-ai/cloud-sdk/runtime";

// 1. Send this runtime's searches and tool calls to Cloud. Attach first.
attach(runtime, { apiKey: process.env.RATEL_API_KEY, sourceId: "${sourceId}" });

// 2. Rank from the graph Cloud builds, without learning locally.
const catalog = runtime.tools.catalog;
const use = (graph) => {
  catalog.experimentalDisableAdaptiveRanking();
  catalog.experimentalEnableAdaptiveRanking(graph, { learn: false, graphKey: "${graphKey}" });
};

// 3. Pull it, and adopt every newer revision. Without onReplaced the runtime
//    keeps the first graph it loaded for as long as it runs.
const sync = await attachIntentGraphSync(runtime, {
  mode: "consume",
  graphKey: "${graphKey}",
  onReplaced: use,
});
use(sync.graph);`;
}

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const done = (steps: SetupStep[]): SetupSteps => ({
  steps,
  allDone: steps.every((s) => s.state === "done"),
});

/**
 * The two steps that come before any graph exists, for the list page: events
 * from runtimes, and Cloud building from them.
 */
export function buildProjectSteps(facts: ProjectSetupFacts): SetupSteps {
  const exampleSource = facts.sources[0]?.sourceId ?? "your-runtime";
  const runtimes = facts.sources.filter((s) => s.lane === "runtime");
  const agents = facts.sources.filter((s) => s.lane === "otlp");
  const sum = (list: typeof facts.sources, key: "searches" | "invokes" | "silentCalls") =>
    list.reduce((n, s) => n + s[key], 0);
  const searches = sum(runtimes, "searches");
  const invokes = sum(runtimes, "invokes");
  // An agent whose model calls carry no ask: content capture is off, and the
  // tool calls alone teach nothing, so they are not counted as evidence.
  const silent = agents.filter((s) => s.searches === 0 && s.silentCalls > 0);
  const heard = agents.filter((s) => !silent.includes(s));
  const asks = sum(heard, "searches");
  const toolCalls = sum(heard, "invokes");

  const sentences: string[] = [];
  if (searches > 0 && invokes > 0) {
    sentences.push(
      `${plural(runtimes.length, "runtime", "runtimes")} sent ${plural(searches, "search", "searches")} and ${plural(invokes, "tool call", "tool calls")}`,
    );
  }
  if (asks > 0 && toolCalls > 0) {
    sentences.push(
      `${plural(heard.length, "agent", "agents")} sent ${plural(asks, "ask", "asks")} and ${plural(toolCalls, "tool call", "tool calls")} over OpenTelemetry`,
    );
  }

  const events: SetupStep =
    sentences.length > 0
      ? {
          key: "events",
          label: "Events arriving",
          state: silent.length > 0 ? "problem" : "done",
          detail:
            silent.length > 0
              ? `${sentences.join("; ")} in the last day. Content capture is off for ${silent.map((s) => s.sourceId).join(", ")}: Cloud sees the tool calls but not what the user asked, so there is nothing to learn from them. Turn on content capture in the exporter.`
              : `${sentences.join("; ")} in the last day.`,
        }
      : silent.length > 0
        ? {
            key: "events",
            label: "Events arriving",
            state: "problem",
            detail: `Content capture is off for ${silent.map((s) => s.sourceId).join(", ")}: Cloud sees the tool calls but not what the user asked, so there is nothing to learn from. Turn on content capture in the exporter.`,
          }
        : searches > 0 || asks > 0
          ? {
              key: "events",
              label: "Events arriving",
              state: "problem",
              detail:
                "Cloud sees searches but no tool calls. It learns from the pair: a search or an ask, and the tool the agent then ran.",
            }
          : {
              key: "events",
              label: "Events arriving",
              state: "pending",
              detail:
                "Nothing from a runtime or an agent in the last day. Attach telemetry so Cloud receives searches and tool calls, or point your OpenTelemetry exporter at Cloud with content capture on.",
              snippet: connectSnippet(exampleSource),
            };

  const cloudGraphs = facts.graphs.filter((g) => isCloudGraphKey(g.graphKey));
  const merged = cloudGraphs.find((g) => g.graphKey === CLOUD_INTENT_GRAPH_KEY) ?? cloudGraphs[0];
  const building: SetupStep = merged
    ? {
        key: "building",
        label: "Graph building",
        state: "done",
        detail: `Cloud has learned ${plural(merged.rev, "turn", "turns")} into ${plural(merged.clusterCount, "query group", "query groups")}.`,
      }
    : {
        key: "building",
        label: "Graph building",
        state: "pending",
        detail: "The first graph appears after the next batch of searches and tool calls arrives.",
      };

  return done([events, building]);
}

/**
 * The two setup steps for one Cloud-built graph, on its own page: a runtime
 * ranks from it and follows its revisions. Whether results then change is
 * the graph's performance, told by the badge and the Boost panel, not a step.
 * Only runtimes that name this graph count, so each graph's page tells its
 * own story and the snippet names its own source.
 */
export function buildGraphSteps(facts: GraphSetupFacts): SetupSteps {
  const { graph } = facts;
  const source = cloudGraphSource(graph.graphKey);
  const onGraph = facts.runtimes.filter(
    (r) => r.status === "active" && r.graphKey === graph.graphKey,
  );
  const snippet = connectSnippet(source ?? onGraph[0]?.sourceId ?? "your-runtime", graph.graphKey);

  const learningCopy = onGraph.find((r) => r.learn);
  const connected: SetupStep =
    onGraph.length === 0
      ? {
          key: "connected",
          label: "Runtime connected",
          state: "pending",
          detail: `No runtime ranks from this graph yet. It starts in your code: add these lines where ${source ?? "the runtime"} starts. Until then Cloud only watches and compares.`,
          snippet,
        }
      : learningCopy
        ? {
            key: "connected",
            label: "Runtime connected",
            state: "problem",
            detail: `${learningCopy.sourceId} is learning into its copy of this graph. Cloud already learns from its events, and the next revision overwrites the copy. Enable with learn: false.`,
            snippet,
          }
        : {
            key: "connected",
            label: "Runtime connected",
            state: "done",
            detail: `${onGraph.map((r) => r.sourceId).join(", ")} ${onGraph.length === 1 ? "ranks" : "rank"} from this graph.`,
          };

  // A runtime that did not wire onReplaced keeps the first graph it loaded:
  // its reported revision stays put while the graph moves on. A well-behaved
  // runtime re-enables, and so reports again, at every adopted poll, so one
  // still on an older revision once the latest change is more than two polls
  // old is not adopting. Measured from now, not from the runtime's last
  // report: a runtime that last reported hours ago has had no chance to adopt
  // a change made a minute ago.
  const stuck = onGraph.find(
    (r) =>
      r.rev !== null &&
      r.rev !== graph.rev &&
      facts.now.getTime() - graph.updatedAt.getTime() > FOLLOW_GRACE_MS,
  );
  const following: SetupStep =
    onGraph.length === 0
      ? {
          key: "following",
          label: "Runtime following updates",
          state: "pending",
          detail: "Once a runtime is connected, Cloud checks that it adopts each newer revision.",
        }
      : stuck
        ? {
            key: "following",
            label: "Runtime following updates",
            state: "problem",
            detail: `${stuck.sourceId} is still on revision ${stuck.rev} and has not adopted the newer graph. It needs an onReplaced handler that re-enables ranking on each new revision; without one, nothing Cloud learns after startup reaches it.`,
            snippet,
          }
        : {
            key: "following",
            label: "Runtime following updates",
            state: "done",
            detail: "Connected runtimes are on the latest revision of this graph.",
          };

  return done([connected, following]);
}

/** How far the newest event may run ahead of the graph before the graph counts as not keeping up. */
export const STALE_GRAPH_MS = 15 * 60_000;

/**
 * Things that have gone wrong after setup, each one a sentence the customer
 * can act on. Empty when there is nothing to say.
 */
export function buildGraphWarnings(input: {
  /** Newest learning event the project received, or null. */
  lastEventAt: Date | null;
  /** When the merged Cloud graph last changed, or null when there is none. */
  graphUpdatedAt: Date | null;
  /** Per Cloud graph, tools it promotes that are no longer in the catalog. */
  missingTools: ReadonlyMap<string, number>;
}): string[] {
  const warnings: string[] = [];
  for (const [graphKey, missing] of [...input.missingTools].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (missing <= 0 || !isCloudGraphKey(graphKey)) continue;
    warnings.push(
      `${graphKey} promotes ${plural(missing, "tool that is", "tools that are")} no longer in your catalog. The agent cannot call ${missing === 1 ? "it" : "them"}; renamed or removed tools leave the graph as new traffic replaces them.`,
    );
  }
  if (
    input.lastEventAt !== null &&
    input.graphUpdatedAt !== null &&
    input.lastEventAt.getTime() - input.graphUpdatedAt.getTime() > STALE_GRAPH_MS
  ) {
    warnings.push(
      "The Cloud graph has not caught up with recent searches. Events are arriving but the graph stopped updating; tell us if this persists.",
    );
  }
  return warnings;
}

/** A graph that makes the agent's tool rank lower on more than this share of compared searches is worth a look. */
export const WORSE_SHARE_WARNING = 0.2;
export const WORSE_MIN_COMPARED = 30;

/** The warning for one graph's page when the comparison says it hurts too often. */
export function buildBoostWarning(verdict: {
  better: number;
  worse: number;
  same: number;
}): string | null {
  const compared = verdict.better + verdict.worse + verdict.same;
  if (compared < WORSE_MIN_COMPARED || verdict.worse / compared <= WORSE_SHARE_WARNING) return null;
  return `On ${verdict.worse} of ${compared} compared searches this graph ranked the tool your agent used lower than it would have been. If this holds, stop ranking from it in your runtime: remove the call that enables adaptive ranking.`;
}

/** Below this many turns on either side, a before-and-after is noise. */
export const OUTCOME_MIN_TURNS = 20;

/** Recall@5 on the lists a runtime served, before and after its graph went live. */
export interface LiveRecall {
  before: number;
  after: number;
  /** Whether it rose; null when it did not move. */
  improved: boolean | null;
}

type OutcomeSide = { turns: number; recallAt5: number | null };

/**
 * The one before-and-after figure shown for a live graph: how often the tool
 * the agent used was in the first five results it was served. Null until both
 * sides have enough turns, or when either side cannot be measured.
 */
export function buildLiveRecall(outcomes: {
  before: OutcomeSide;
  after: OutcomeSide;
}): LiveRecall | null {
  const { before, after } = outcomes;
  if (before.turns < OUTCOME_MIN_TURNS || after.turns < OUTCOME_MIN_TURNS) return null;
  if (before.recallAt5 === null || after.recallAt5 === null) return null;
  const moved = Math.abs(after.recallAt5 - before.recallAt5) >= 0.005;
  return {
    before: before.recallAt5,
    after: after.recallAt5,
    improved: moved ? after.recallAt5 > before.recallAt5 : null,
  };
}
