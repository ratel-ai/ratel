import { z } from "zod";
import { notFound } from "@/lib/mcp/errors";
import {
  type ContentAccessDeps,
  contentHint,
  mayReadContent,
  readContentOptIn,
  withheldMarker,
} from "@/lib/mcp/operations/content-access";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { capRows, limitParam, round, TruncationTracker } from "@/lib/mcp/serialize";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import {
  loadStoredTopics,
  loadTaskRuns,
  loadTopicReading,
  type TaskSummary,
  topicReadingInFlight,
} from "@/lib/readings/topics/queries";
import type {
  FlowStats,
  StoredTopic,
  TopicFlows,
  TopicInsights,
} from "@/lib/readings/topics/types";
import { loadWorkflowLabels } from "@/lib/readings/trace-signals/workflows/label-queries";
import type { WorkflowLabels } from "@/lib/readings/trace-signals/workflows/name";
import type { IntentBreakdown } from "@/lib/views/intents/breakdown";
import { loadIntentBreakdown } from "@/lib/views/intents/breakdown-queries";
import {
  type ExampleAsk,
  exampleTurnIds,
  loadExampleAsks,
} from "@/lib/views/intents/topics-examples";
import { type IntentStepsRead, loadIntentSteps } from "@/lib/views/intents/topics-steps-load";
import {
  buildTopicsView,
  intentsRoot,
  nextLabel,
  sortTopics,
  type TopicsView,
  type TopicView,
} from "@/lib/views/intents/topics-view";

/**
 * Intents over MCP: the All intents page (`list_intents`, with the Flows read
 * compactly) and one intent's panel (`get_intent`: what its asks are for, the
 * ways people ask it, the steps it is done in, and a few example asks).
 *
 * The reads are the page's own (`app/(app)/project/[projectId]/intents/data.ts`
 * and its server actions), called through `lib/**`. Example asks and the ways
 * people ask are captured end-user text: read on demand for one intent, as
 * the panel reads them, never logged, cut short here, and returned only to a
 * caller that may read captured text (`mayReadContent`).
 */

/** What the Intents pages read in one bounded transaction. */
export interface IntentsRead {
  reading: { insights: TopicInsights; computedAt: Date } | null;
  inFlight: boolean;
  topics: StoredTopic[];
  tasks: TaskSummary[];
  labels: WorkflowLabels;
}

export interface IntentsOperationDeps extends ContentAccessDeps {
  readIntents: (projectId: string) => Promise<IntentsRead>;
  /** Null when the engine placed nothing in the intent, or the read failed (logged where it is read). */
  loadIntentBreakdown: (projectId: string, topicId: string) => Promise<IntentBreakdown | null>;
  loadIntentSteps: (projectId: string, topicId: string) => Promise<IntentStepsRead>;
  loadExampleAsks: (projectId: string, ids: readonly string[]) => Promise<ExampleAsk[]>;
}

export const defaultIntentsDeps: IntentsOperationDeps = {
  readIntents: (projectId) =>
    withStatementTimeout(
      async (db): Promise<IntentsRead> => {
        const reading = await loadTopicReading(projectId, db);
        const inFlight = await topicReadingInFlight(projectId, db);
        if (!reading) return { reading: null, inFlight, topics: [], tasks: [], labels: new Map() };
        const topics = await loadStoredTopics(projectId, db);
        const tasks = await loadTaskRuns(projectId, db);
        const labels = await loadWorkflowLabels(projectId, db);
        return { reading, inFlight, topics, tasks, labels };
      },
      { operation: "topics_reading" },
    ),
  loadIntentBreakdown: (projectId, topicId) => loadIntentBreakdown(projectId, topicId),
  loadIntentSteps: (projectId, topicId) => loadIntentSteps(projectId, topicId),
  loadExampleAsks: (projectId, ids) => loadExampleAsks(projectId, ids),
  contentOptIn: readContentOptIn,
};

const intentIdParam = z.string().min(1).max(128).describe("An intent id from list_intents.");

const TASKS_SHOWN = 3;
const TOOLS_SHOWN = 8;
const NEXT_SHOWN = 5;
const FLOW_NODES_SHOWN = 5;
const FLOW_NEXT_SHOWN = 3;
const GROUPS_SHOWN = 10;
const WAYS_SHOWN = 5;
const SAMPLES_SHOWN = 2;
const ASK_CHARS = 200;
const LABEL_CHARS = 160;
const DESCRIPTION_CHARS = 300;

function intentHref(projectId: string, topicId: string): string {
  return `${intentsRoot(projectId)}?peek=${encodeURIComponent(topicId)}`;
}

function viewOf(
  projectId: string,
  read: IntentsRead & { reading: NonNullable<IntentsRead["reading"]> },
): TopicsView {
  return buildTopicsView({
    projectId,
    insights: read.reading.insights,
    topics: read.topics,
    tasks: read.tasks,
    taskLabels: read.labels,
  });
}

function intentRow(projectId: string, topic: TopicView, tracker: TruncationTracker) {
  return {
    id: topic.id,
    name: topic.name,
    description: tracker.text(topic.description, DESCRIPTION_CHARS),
    turns: topic.turns,
    share: round(topic.share),
    asks: topic.asks,
    conversations: topic.conversations ?? null,
    answered: topic.answered,
    answeredShare: round(topic.answeredShare),
    mostlyUnanswered: topic.mostlyUnanswered,
    sentiment: topic.sentiment
      ? { ...topic.sentiment, negativeShare: round(topic.sentiment.negativeShare) }
      : null,
    tasks: tracker.take(capRows(topic.tasks, TASKS_SHOWN)).map((task) => ({
      id: task.id,
      name: task.name,
      turns: task.turns,
      share: round(task.share),
    })),
    untasked: topic.untasked,
    tools: tracker.take(capRows(topic.tools, TOOLS_SHOWN)).map((tool) => ({
      id: tool.id,
      calls: tool.calls,
      failures: tool.failures,
      failureShare: round(tool.failureShare),
    })),
    selfCorrections: topic.selfCorrections,
    askedAgain: topic.askedAgain,
    askedNext: tracker.take(capRows(topic.next, NEXT_SHOWN)).map((next) => ({
      key: next.key,
      kind: next.kind,
      label: next.label,
      sessions: next.sessions,
      share: round(next.share),
    })),
    trend: topic.trend,
    href: intentHref(projectId, topic.id),
  };
}

/** One Flows view: per step, the busiest places conversations were and where they went next. */
function flowStatsView(
  stats: FlowStats,
  label: (key: string) => string,
  tracker: TruncationTracker,
) {
  return {
    sessions: stats.sessions,
    multiTurn: stats.multiTurn,
    wentOn: stats.wentOn,
    steps: stats.columns.map((column) => ({
      position: column.position,
      sessions: column.sessions,
      ended: column.ended,
      nodes: tracker.take(capRows(column.nodes, FLOW_NODES_SHOWN)).map((node) => ({
        key: node.key,
        label: label(node.key),
        sessions: node.sessions,
        ended: node.ended,
        unanswered: node.unanswered,
        next: tracker
          .take(capRows(node.next, FLOW_NEXT_SHOWN))
          .map((next) => ({ key: next.key, label: label(next.key), sessions: next.sessions })),
      })),
    })),
  };
}

function flowsView(flows: TopicFlows | null, view: TopicsView, tracker: TruncationTracker) {
  if (!flows) return null;
  const names = new Map(view.topics.map((topic) => [topic.id, topic.name]));
  const label = (key: string) =>
    nextLabel(key, names, (id) => view.taskNames[id] ?? "A task").label;
  return {
    all: flowStatsView(flows.all, label, tracker),
    starts: flows.starts.map((id) => ({ id, name: names.get(id) ?? "Intent" })),
  };
}

function breakdownView(
  breakdown: IntentBreakdown,
  names: ReadonlyMap<string, string>,
  tracker: TruncationTracker,
  content: boolean,
) {
  const nameOf = (id: string) => names.get(id) ?? "Intent";
  const groups = breakdown.whatTheyAskFor;
  // Withheld, a label that is an ask as written is null and no sample is listed; a model's name stays.
  const label = (text: string, asWritten: boolean) =>
    !content && asWritten ? null : tracker.text(text, LABEL_CHARS);
  return {
    asks: breakdown.asks,
    placed: breakdown.placed,
    capped: breakdown.capped,
    whatTheyAskFor: {
      skipped: groups.skipped,
      more: groups.more + Math.max(0, groups.groups.length - GROUPS_SHOWN),
      groups: tracker.take(capRows(groups.groups, GROUPS_SHOWN)).map((group) => ({
        id: group.id,
        // A label no model wrote is an ask as written: quoted, and cut short.
        label: label(group.label, group.quoted),
        quoted: group.quoted,
        asks: group.asks,
        share: round(group.share),
        alsoIn: group.alsoIn.map((other) => ({
          intentId: other.topicId,
          name: nameOf(other.topicId),
          asks: other.asks,
        })),
        waysOfAsking: {
          more: group.waysOfAsking.more + Math.max(0, group.waysOfAsking.ways.length - WAYS_SHOWN),
          ways: tracker.take(capRows(group.waysOfAsking.ways, WAYS_SHOWN)).map((way) => ({
            // A way of asking is named by its most typical ask, as written.
            label: label(way.label, true),
            asks: way.asks,
            of: way.of,
            samples: content
              ? tracker
                  .take(capRows(way.samples, SAMPLES_SHOWN))
                  .map((sample) => tracker.text(sample, ASK_CHARS))
              : [],
          })),
        },
      })),
    },
    elsewhere: {
      asks: breakdown.elsewhere.asks,
      // These carry no quoted flag, so withheld they are left unlabelled.
      groups: breakdown.elsewhere.groups.map((group) => ({
        label: label(group.label, true),
        intentId: group.topicId,
        name: nameOf(group.topicId),
        asks: group.asks,
      })),
    },
    alsoWants: breakdown.alsoWants.map((other) => ({
      intentId: other.topicId,
      name: nameOf(other.topicId),
      asks: other.asks,
      share: round(other.share),
    })),
  };
}

function stepsView(read: IntentStepsRead) {
  if (read.status !== "ready") return { status: read.status };
  const steps = read.steps;
  const tool = (item: { id: string; turns: number; share: number }) => ({
    id: item.id,
    turns: item.turns,
    share: round(item.share),
  });
  return {
    status: "ready" as const,
    turns: steps.turns,
    withCalls: steps.withCalls,
    usualWay: steps.sentence
      ? {
          tools: steps.sentence.tools.map(tool),
          together: steps.sentence.together,
          togetherShare: round(steps.sentence.togetherShare),
          inOrderShare: round(steps.sentence.inOrderShare),
          fixedOrder: steps.sentence.fixedOrder,
        }
      : null,
    startsWith: steps.firsts.map(tool),
    alsoRuns: steps.also.map(tool),
    helpers: steps.helpers.map(tool),
    task: steps.task
      ? {
          id: steps.task.id,
          turns: steps.task.turns,
          share: round(steps.task.share),
          exact: steps.task.exact,
        }
      : null,
  };
}

export function intentsOperations(deps: IntentsOperationDeps = defaultIntentsDeps): McpOperation[] {
  return [
    defineOperation({
      id: "list_intents",
      domain: "observability",
      title: "List intents",
      description:
        "The Intents page: what people want from the agent, each intent with turns, share, answered rate, sentiment, tasks, tools, self-corrections, asked again, what people ask next and trend, plus the Flows (where conversations go step by step). Call get_intent for one intent's breakdown.",
      keywords: ["intents", "what users ask", "answered rate", "ask next", "conversation flows"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        sort: z
          .enum(["turns", "answered", "negative", "name"])
          .default("turns")
          .describe(
            "turns: busiest first. answered: least answered first. negative: most negative first. name: A to Z.",
          ),
        includeFlows: z
          .boolean()
          .default(true)
          .describe("Include the Flows: where conversations go, step by step."),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const read = await deps.readIntents(ctx.projectId);
        if (!read.reading) {
          return {
            data: { status: "none", inFlight: read.inFlight, intents: [] },
            hint: read.inFlight
              ? "A reading is queued or running. get_analysis_freshness with section intents shows when it lands."
              : "No intents reading yet. request_analysis with what: intents starts one.",
          };
        }
        const tracker = new TruncationTracker();
        const { insights, computedAt } = read.reading;
        const view = viewOf(ctx.projectId, { ...read, reading: read.reading });
        const page = tracker.take(capRows(sortTopics(view.topics, params.sort), params.limit));
        return {
          data: {
            status: "ready",
            computedAt: computedAt.toISOString(),
            inFlight: read.inFlight,
            windowDays: view.windowDays,
            capped: view.capped,
            summary: view.summary,
            intents: page.map((topic) => intentRow(ctx.projectId, topic, tracker)),
            ...(params.includeFlows
              ? {
                  flows: flowsView(insights.flows, view, tracker),
                  flowsBlocked: insights.flowsBlocked,
                  lanes: insights.lanes ?? null,
                }
              : {}),
            href: intentsRoot(ctx.projectId),
          },
          truncated: tracker.value,
          hint: "get_intent with an intentId reads what its asks are for, the steps it is done in and example asks. get_self_corrections with intent narrows self-corrections to one.",
        };
      },
    }),
    defineOperation({
      id: "get_intent",
      domain: "observability",
      title: "Get intent",
      description:
        "One intent's panel: its numbers, what its asks are for and the ways people ask it, what else the same ask wants, the steps it is done in (usual tools and order, matching task) and a few example asks, cut short. Intent ids come from list_intents.",
      keywords: ["intent breakdown", "ways of asking", "example asks", "intent steps"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        intentId: intentIdParam,
        examples: z
          .number()
          .int()
          .min(0)
          .max(5)
          .default(3)
          .describe("Example asks to include (0 to 5)."),
      }),
      async execute(ctx, params) {
        const read = await deps.readIntents(ctx.projectId);
        if (!read.reading) throw notFound("intent");
        const view = viewOf(ctx.projectId, { ...read, reading: read.reading });
        const topic = view.topics.find((item) => item.id === params.intentId);
        if (!topic) throw notFound("intent");
        const content = await mayReadContent(ctx, deps);
        const exampleIds =
          params.examples > 0
            ? exampleTurnIds(read.reading.insights, { kind: "topic", topicId: topic.id }).slice(
                0,
                params.examples,
              )
            : [];
        const [breakdown, steps, examples] = await Promise.all([
          deps.loadIntentBreakdown(ctx.projectId, topic.id),
          deps.loadIntentSteps(ctx.projectId, topic.id),
          exampleIds.length > 0
            ? deps.loadExampleAsks(ctx.projectId, exampleIds)
            : Promise.resolve([]),
        ]);
        const tracker = new TruncationTracker();
        const names = new Map(view.topics.map((item) => [item.id, item.name]));
        return {
          data: {
            intent: intentRow(ctx.projectId, topic, tracker),
            breakdown: breakdown ? breakdownView(breakdown, names, tracker, content) : null,
            steps: stepsView(steps),
            exampleAsks: examples.map((example) => ({
              text: content ? tracker.text(example.text, ASK_CHARS) : null,
              source: example.source,
              href: example.href,
            })),
            links: topic.links,
            ...withheldMarker(content),
          },
          truncated: tracker.value,
          hint: contentHint(
            content,
            "list_fixes with the intent's tasks, or get_self_corrections with intent, show what to change; get_session replays one conversation.",
          ),
        };
      },
    }),
  ];
}
