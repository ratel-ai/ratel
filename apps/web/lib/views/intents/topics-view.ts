import { type TaskColorSlot, taskColors } from "@ratel/design-system/task-colors";
import { projectRoot } from "@/lib/console/navigation";
import {
  type CountedTool,
  flowTaskId,
  flowToolId,
  MOST_NEGATIVE_MIN_TURNS,
  NEXT_ENDED,
  NEXT_OTHER,
  NEXT_RETRY,
  type StoredTopic,
  type TopicFlows,
  type TopicInsights,
  type TopicStats,
  UNANSWERED_MARK_MIN_TURNS,
  UNANSWERED_MARK_SHARE,
} from "@/lib/readings/topics/types";
import {
  type WorkflowLabels,
  workflowDisplayName,
} from "@/lib/readings/trace-signals/workflows/name";

/**
 * What the Intents pages show, from a stored reading: one row per topic with
 * its numbers in plain terms, the header's totals, and the links every topic
 * carries to its neighbours (tasks, self-corrections, fixes, flows). Pure, so
 * the pages and their tests read the same shape.
 *
 * Privacy: topic and task names are model-written from captured asks (or, with
 * no model, the asks' own words). They are text only: wherever a name would
 * land in an attribute, the id is used instead.
 */

/** Buckets the 30-day trend is drawn in: two days each. */
export const TREND_BUCKET_DAYS = 2;

export interface TaskRef {
  id: string;
  name: string;
  /** Its color, when it is one of the three busiest tasks; neutral otherwise. */
  slot: TaskColorSlot | null;
  href: string;
}

export interface TopicTask extends TaskRef {
  turns: number;
  /** Of the topic's turns. */
  share: number;
}

export type NextKind = "topic" | "task" | "tool" | "retry" | "other" | "ended";

export interface TopicNext {
  key: string;
  kind: NextKind;
  label: string;
  sessions: number;
  share: number;
  /** Where a task or tool opens: its task's page, its Catalog row. */
  href: string | null;
  /** A task's color. */
  slot?: TaskColorSlot | null;
}

export interface TopicView {
  id: string;
  name: string;
  description: string;
  turns: number;
  /** Of every turn read. */
  share: number;
  asks: number;
  /** Conversations its turns were asked in; null (or absent) when conversations can't be told apart. */
  conversations?: number | null;
  /** Turns per two days, oldest first. */
  trend: number[];
  answered: number;
  answeredShare: number;
  mostlyUnanswered: boolean;
  sentiment: {
    positive: number;
    neutral: number;
    negative: number;
    measured: number;
    negativeShare: number;
  } | null;
  tasks: TopicTask[];
  untasked: number;
  /** Each with where it opens in Catalog. */
  tools: (CountedTool & { failureShare: number; href?: string })[];
  selfCorrections: {
    events: number;
    turns: number;
    kinds: { kind: string; label: string; events: number }[];
  } | null;
  askedAgain: number;
  next: TopicNext[];
  /** Whether the Flows page has a view starting in it. */
  flowStart: boolean;
  /** The main task's color, for the map. */
  slot: TaskColorSlot | null;
  links: { selfCorrections: string; fixes: string; flows: string };
}

export interface TopicsSummary {
  topics: number;
  /** Closed turns read. */
  turns: number;
  inTopic: number;
  unanswered: number;
  askedAgain: number;
  unplaced: number;
  /** Turns with no message, prompt or search to read. */
  noAsk: number;
  /** Distinct tasks that handle the topics' turns. */
  tasks: number;
  sentimentMeasured: boolean;
  /**
   * How sentiment was read, over every turn: how many carried the person's
   * own words, of how many, and how many of those a model read (the keyword
   * list read the rest). `model` is null on readings that did not keep it.
   */
  sentimentRead: { measured: number; of: number; model: number | null };
  mostNegative: { id: string; name: string; negative: number; measured: number } | null;
}

export interface TopicsView {
  topics: TopicView[];
  summary: TopicsSummary;
  windowDays: number;
  capped: boolean;
  /** Task colors, by task id, for every task drawn. */
  taskSlots: Record<string, TaskColorSlot>;
  taskNames: Record<string, string>;
}

/** What the Intents pages read, from the latest reading. */
export type IntentsReading =
  | { status: "failed" }
  /** No reading yet; `inFlight` when one is queued or running. */
  | { status: "none"; inFlight: boolean }
  | {
      status: "ready";
      view: TopicsView;
      /** Ids and counts only: what the Flows and the panels read. */
      flows: TopicFlows | null;
      flowsBlocked: TopicInsights["flowsBlocked"];
      /** Which lanes the turns came by; null on readings before it was kept. */
      lanes: NonNullable<TopicInsights["lanes"]> | null;
      tools: TopicInsights["tools"];
      turns: number;
      modelOnlyTurns: number;
      read: { relative: string; absolute: string };
      inFlight: boolean;
    };

/** The plain words for each self-correction kind (DESIGN.md, Glossary). */
export const SELF_CORRECTION_LABELS: Record<string, string> = {
  retry_after_error: "Retried",
  switch_after_error: "Switched tools",
  gave_up_after_error: "Gave up",
  searched_again: "Searched again",
  asked_again: "Asked again",
  phrase: "Apologized",
};

export interface TaskInfo {
  id: string;
  runs: number;
  typicalOrder: readonly string[];
}

export interface TopicsViewInput {
  projectId: string;
  insights: TopicInsights;
  /** Every stored topic; retired ones are listed only if the reading still counts them. */
  topics: readonly StoredTopic[];
  tasks: readonly TaskInfo[];
  /** Model-written task names, by id. */
  taskLabels: WorkflowLabels;
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

export function intentsRoot(projectId: string): string {
  return `${projectRoot(projectId)}/intents`;
}

/** Where the old Asks tab lands: Topics, with the panel it had open (an id) carried over. */
export function asksRedirectHref(projectId: string, peek: string | undefined): string {
  return `${intentsRoot(projectId)}${peek ? `?peek=${encodeURIComponent(peek)}` : ""}`;
}

const SKILL_PREFIX = "skill:";

/** A tool's row in Catalog, found and highlighted; a skill (`skill:<id>`) opens the Skills catalog. */
export function toolCatalogHref(projectId: string, toolId: string): string {
  const root = `${projectRoot(projectId)}/catalogs`;
  if (toolId.startsWith(SKILL_PREFIX)) return `${root}/skills`;
  const id = encodeURIComponent(toolId);
  return `${root}/tools?q=${id}&highlight=${id}`;
}

export function taskHref(projectId: string, taskId: string): string {
  return `${projectRoot(projectId)}/health/tasks/${encodeURIComponent(taskId)}`;
}

/** The topic's links to its neighbours: ids in the query, never names. */
export function topicLinks(
  projectId: string,
  topicId: string,
  flowStart: boolean,
): TopicView["links"] {
  const root = projectRoot(projectId);
  const id = encodeURIComponent(topicId);
  return {
    selfCorrections: `${root}/health/self-corrections?topic=${id}`,
    fixes: `${root}/improvement/fixes?topic=${id}`,
    flows: flowStart
      ? `${intentsRoot(projectId)}/flows?start=${id}`
      : `${intentsRoot(projectId)}/flows`,
  };
}

/** Two-day buckets of a daily series, oldest first, counted back from today so the last bucket is whole. */
export function trendBuckets(daily: readonly number[], days: number = TREND_BUCKET_DAYS): number[] {
  const out: number[] = [];
  for (let end = daily.length; end > 0; end -= days) {
    out.unshift(daily.slice(Math.max(0, end - days), end).reduce((sum, n) => sum + n, 0));
  }
  return out;
}

/** Whether most of a topic's (or a step's) turns went unanswered, over enough of them to say so. */
export function mostlyUnanswered(unanswered: number, turns: number): boolean {
  return turns >= UNANSWERED_MARK_MIN_TURNS && unanswered / turns > UNANSWERED_MARK_SHARE;
}

export function nextLabel(
  key: string,
  names: ReadonlyMap<string, string>,
  taskName?: (id: string) => string,
): { kind: NextKind; label: string } {
  if (key === NEXT_ENDED) return { kind: "ended", label: "Ended" };
  if (key === NEXT_RETRY) return { kind: "retry", label: "Asked again" };
  if (key === NEXT_OTHER) return { kind: "other", label: "Something else" };
  const task = flowTaskId(key);
  if (task !== null) return { kind: "task", label: taskName ? taskName(task) : "A task" };
  const tool = flowToolId(key);
  if (tool !== null) return { kind: "tool", label: tool };
  const name = names.get(key);
  return name ? { kind: "topic", label: name } : { kind: "other", label: "Something else" };
}

function topicView(
  stats: TopicStats,
  stored: StoredTopic | undefined,
  input: TopicsViewInput,
  context: {
    names: ReadonlyMap<string, string>;
    slots: ReadonlyMap<string, TaskColorSlot>;
    taskName: (id: string) => string;
    starts: ReadonlySet<string>;
    conversationsKnown: boolean;
  },
): TopicView {
  const measured = stats.sentiment
    ? stats.sentiment.positive + stats.sentiment.neutral + stats.sentiment.negative
    : 0;
  const nextTotal = stats.next.reduce((sum, next) => sum + next.sessions, 0);
  const flowStart = context.starts.has(stats.id);
  const main = stats.tasks[0]?.id ?? null;
  return {
    id: stats.id,
    name: stored?.name ?? "Intent",
    description: stored?.description ?? "",
    turns: stats.turns,
    share: ratio(stats.turns, input.insights.turns),
    asks: stats.asks,
    conversations: context.conversationsKnown ? (stats.conversations ?? null) : null,
    trend: trendBuckets(stats.daily),
    answered: stats.answered,
    answeredShare: ratio(stats.answered, stats.turns),
    mostlyUnanswered: mostlyUnanswered(stats.turns - stats.answered, stats.turns),
    sentiment: stats.sentiment
      ? { ...stats.sentiment, measured, negativeShare: ratio(stats.sentiment.negative, measured) }
      : null,
    tasks: stats.tasks.map((task) => ({
      id: task.id,
      name: context.taskName(task.id),
      slot: context.slots.get(task.id) ?? null,
      href: taskHref(input.projectId, task.id),
      turns: task.turns,
      share: ratio(task.turns, stats.turns),
    })),
    untasked: stats.untasked,
    tools: stats.tools.map((tool) => ({
      ...tool,
      failureShare: ratio(tool.failures, tool.calls),
      href: toolCatalogHref(input.projectId, tool.id),
    })),
    selfCorrections: stats.selfCorrections
      ? {
          events: stats.selfCorrections.events,
          turns: stats.selfCorrections.turns,
          kinds: Object.entries(stats.selfCorrections.byKind)
            .map(([kind, events]) => ({
              kind,
              label: SELF_CORRECTION_LABELS[kind] ?? "Other",
              events,
            }))
            .sort((a, b) => b.events - a.events || a.label.localeCompare(b.label)),
        }
      : null,
    askedAgain: stats.askedAgain,
    next: stats.next.map((next) => {
      const task = flowTaskId(next.key);
      const tool = flowToolId(next.key);
      return {
        key: next.key,
        ...nextLabel(next.key, context.names, context.taskName),
        sessions: next.sessions,
        share: ratio(next.sessions, nextTotal),
        href:
          task !== null
            ? taskHref(input.projectId, task)
            : tool !== null
              ? toolCatalogHref(input.projectId, tool)
              : null,
        slot: task !== null ? (context.slots.get(task) ?? null) : null,
      };
    }),
    flowStart,
    slot: main ? (context.slots.get(main) ?? null) : null,
    links: topicLinks(input.projectId, stats.id, flowStart),
  };
}

/** The most negative topic among those read for sentiment often enough; null when none reads negative. */
function mostNegative(topics: readonly TopicView[]): TopicsSummary["mostNegative"] {
  const candidates = topics.filter(
    (topic) =>
      topic.sentiment &&
      topic.sentiment.measured >= MOST_NEGATIVE_MIN_TURNS &&
      topic.sentiment.negative > 0,
  );
  const best = candidates.sort(
    (a, b) =>
      b.sentiment!.negativeShare - a.sentiment!.negativeShare ||
      b.turns - a.turns ||
      a.id.localeCompare(b.id),
  )[0];
  return best
    ? {
        id: best.id,
        name: best.name,
        negative: best.sentiment!.negative,
        measured: best.sentiment!.measured,
      }
    : null;
}

/**
 * Whether a reading can tell conversations apart: sessions are trusted, and
 * most turns carried a conversation. A telemetry turn with no conversation id
 * is a conversation of its own, so counting those would only repeat the asks.
 */
export function conversationsReadable(insights: Pick<TopicInsights, "flows" | "lanes">): boolean {
  if (!insights.flows) return false;
  const lanes = insights.lanes;
  if (!lanes) return true;
  const total = lanes.telemetry + lanes.sdk;
  return total === 0 || lanes.telemetryWithoutConversation * 2 <= total;
}

export function buildTopicsView(input: TopicsViewInput): TopicsView {
  const stored = new Map(input.topics.map((topic) => [topic.topicId, topic]));
  const names = new Map(
    input.insights.topics.map((stats) => [stats.id, stored.get(stats.id)?.name ?? "Intent"]),
  );
  const slots = taskColors(input.tasks.map((task) => ({ id: task.id, runs: task.runs })));
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const taskName = (id: string) => {
    const task = tasks.get(id);
    return (
      workflowDisplayName(
        { id, typicalOrder: task?.typicalOrder ?? [] },
        undefined,
        input.taskLabels,
      ) || "Unnamed task"
    );
  };
  const starts = new Set(input.insights.flows?.starts ?? []);
  const conversationsKnown = conversationsReadable(input.insights);
  const topics = input.insights.topics
    .filter((stats) => stored.has(stats.id))
    .map((stats) =>
      topicView(stats, stored.get(stats.id), input, {
        names,
        slots,
        taskName,
        starts,
        conversationsKnown,
      }),
    );
  const inTopic = topics.reduce((sum, topic) => sum + topic.turns, 0);
  const flowTaskIds = (
    input.insights.flows
      ? [input.insights.flows.all, ...Object.values(input.insights.flows.byStart ?? {})]
      : []
  )
    .flatMap((flow) =>
      flow.columns.flatMap((column) => column.nodes.map((node) => flowTaskId(node.key))),
    )
    .filter((id): id is string => id !== null);
  const taskIds = new Set([
    ...topics.flatMap((topic) => topic.tasks.map((task) => task.id)),
    ...input.insights.tools.flatMap((tool) => (tool.task ? [tool.task] : [])),
    ...flowTaskIds,
  ]);
  return {
    topics,
    summary: {
      topics: topics.length,
      turns: input.insights.turns,
      inTopic,
      unanswered: topics.reduce((sum, topic) => sum + (topic.turns - topic.answered), 0),
      askedAgain: input.insights.verdicts.retry,
      unplaced: input.insights.verdicts.none,
      noAsk: input.insights.verdicts.no_ask,
      tasks: new Set(topics.flatMap((topic) => topic.tasks.map((task) => task.id))).size,
      sentimentMeasured: input.insights.sentimentMeasured > 0,
      sentimentRead: {
        measured: input.insights.sentimentMeasured,
        of: input.insights.turns,
        model: input.insights.sentimentRead?.model ?? null,
      },
      mostNegative: mostNegative(topics),
    },
    windowDays: input.insights.windowDays,
    capped: input.insights.capped,
    taskSlots: Object.fromEntries([...slots].filter(([id]) => taskIds.has(id))),
    taskNames: Object.fromEntries([...taskIds].map((id) => [id, taskName(id)])),
  };
}

/** Topics sorted for the table. `turns` busiest first; `answered` least answered first; `negative` most negative first; `name` A to Z. */
export type TopicSort = "turns" | "answered" | "negative" | "name";

export function parseTopicSort(raw: string | null | undefined): TopicSort {
  return raw === "answered" || raw === "negative" || raw === "name" ? raw : "turns";
}

export function sortTopics(topics: readonly TopicView[], sort: TopicSort): TopicView[] {
  const rows = [...topics];
  if (sort === "name") return rows.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "answered")
    return rows.sort((a, b) => a.answeredShare - b.answeredShare || b.turns - a.turns);
  if (sort === "negative") {
    return rows.sort(
      (a, b) =>
        (b.sentiment?.negativeShare ?? -1) - (a.sentiment?.negativeShare ?? -1) ||
        b.turns - a.turns,
    );
  }
  return rows.sort((a, b) => b.turns - a.turns || a.name.localeCompare(b.name));
}
