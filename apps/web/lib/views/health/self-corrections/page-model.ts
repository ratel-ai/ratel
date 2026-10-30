import { type TaskColorSlot, taskColors } from "@ratel/design-system/task-colors";
import { formatCount, formatSharePercent } from "@/lib/readings/trace-signals/claims";
import type {
  SelfCorrectionKind,
  SelfCorrectionTrust,
} from "@/lib/readings/trace-signals/self-corrections/detect";
import { catalogEntryOf } from "@/lib/readings/trace-signals/self-corrections/issues";
import {
  type FixPattern,
  PATTERN_REASONS,
  PLAIN_KIND_LABELS,
  PLAIN_KINDS,
  type PlainKind,
  plainKindOf,
} from "@/lib/readings/trace-signals/self-corrections/kinds";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import {
  catalogHref,
  fixesHref,
  type SelfCorrectionFilters,
  selfCorrectionsHref,
  taskHref,
  topicHref,
} from "@/lib/views/health/self-corrections/paths";

/**
 * The Self-corrections page, display-ready: the header numbers against the
 * window before and their trend, the breakdowns (by kind, after which tool
 * call, by task, by intent, top phrases), examples to open, and the fixes of
 * the open issues. Pure: `page-load.ts` does the reads and hands over grouped
 * counts, so a window of any size is a few hundred groups, never its rows.
 * Intents are still `topic` in code; the words say "intent".
 */

/** One group of stored self-corrections in the window. */
export interface CorrectionGroup {
  kind: string;
  phraseCategory: string | null;
  phrase: string | null;
  /** The call before them, as a node id. */
  toolId: string | null;
  /** The task and topic of their turn. */
  workflowId: string | null;
  topicId: string | null;
  events: number;
}

/** One recent self-correction to show, without any text. */
export interface CorrectionExample {
  id: string;
  turnId: string;
  kind: string;
  phraseCategory: string | null;
  phrase: string | null;
  toolId: string | null;
  toolOutcome: string | null;
  occurredAt: Date;
  /** A phrase row whose reply can be read back from content capture. */
  hasText: boolean;
  turnKey: string;
  /** The `trace_events` id of the step the row points at, for Traces to focus. */
  focusEventId: string | null;
}

/** An open `self_correcting` issue, in the words of its card. */
export interface CorrectionIssue {
  id: string;
  subjectKind: string;
  subjectKey: string;
  claim: string;
  fix: string;
  pattern: FixPattern;
  topicId: string | null;
  severity: number;
  /** The node its fix names (`metrics.fixTool`): the tool itself, or a task's tool of that pattern. */
  fixTool?: string | null;
}

/** Turns and self-corrections in one bucket of the trend (bucket 0 is the oldest). */
export interface BucketCount {
  bucket: number;
  turns: number;
  events: number;
}

/** Self-corrections per 100 turns over the window, bucket by bucket. */
export interface TrendView {
  /** Oldest first; null where no turn ended in the bucket. */
  values: (number | null)[];
  /** Days per bucket: 1 up to {@link TREND_DAILY_UP_TO} days, a week beyond. */
  bucketDays: number;
  /** The mark's accessible name. */
  label: string;
}

/** Negative sentiment in turns with a self-correction and in turns without, when people's words were read. */
export interface SentimentCounts {
  corrected: { negative: number; measured: number };
  clean: { negative: number; measured: number };
}

/** What the latest reading that wrote self-corrections says about them. */
export interface CorrectionRunFacts {
  computedAt: string;
  trust: SelfCorrectionTrust;
  /** Turns with a captured reply in that reading: phrases are measured only when there were some. */
  turnsWithReplies: number;
}

export interface CorrectionReads {
  run: CorrectionRunFacts | null;
  current: {
    turns: number;
    groups: readonly CorrectionGroup[];
    failedCalls: number;
    recoveredCalls: number;
  };
  /** The window bucket by bucket (`trendBucketDays`), for the trend; absent when not read. */
  buckets?: readonly BucketCount[];
  /** The window before, when stored self-corrections cover it; null otherwise. */
  previous: { turns: number; events: number } | null;
  taskTurns: ReadonlyMap<string, number>;
  topicTurns: ReadonlyMap<string, number>;
  examples: readonly CorrectionExample[];
  issues: readonly CorrectionIssue[];
  sentiment: SentimentCounts | null;
}

export interface CorrectionNames {
  /** Display names by catalog id. */
  tools: ReadonlyMap<string, string>;
  /** Tasks by id: display name and runs (the three busiest wear a color). */
  tasks: ReadonlyMap<string, { name: string; runs: number }>;
  topics: ReadonlyMap<string, string>;
}

/** `unavailable`: the read failed (set by the loader's fallback, never by the builder). */
export type PageState = "not_read" | "mixed_runs" | "no_turns" | "ready" | "unavailable";

export interface StatView {
  label: string;
  value: string;
  hint: string;
  delta?: { value: string; direction: "up" | "down" | "flat"; good: boolean | null; label: string };
}

export interface KindRow {
  kind: PlainKind;
  label: string;
  events: number;
  /** Of all self-corrections in the window. */
  share: number;
  /** False for the phrase kinds when no reply was captured. */
  measured: boolean;
}

export interface ToolRow {
  node: string;
  /** Its catalog id and kind, for its pin. */
  entryId: string;
  entryKind: "tool" | "skill";
  name: string;
  events: number;
  share: number;
  mainKind: string;
  filterHref: string;
  catalogHref: string;
  task: { id: string; name: string; href: string } | null;
}

export interface TaskRow {
  id: string;
  name: string;
  color: TaskColorSlot | null;
  events: number;
  turns: number;
  /** Per 100 of the task's runs; null without runs in the window. */
  per100: number | null;
  share: number;
  href: string;
  filterHref: string;
}

export interface TopicRow {
  id: string;
  name: string;
  events: number;
  turns: number;
  per100: number | null;
  share: number;
  href: string;
  filterHref: string;
}

export interface PhraseRow {
  phrase: string;
  kindLabel: string;
  events: number;
  share: number;
}

export interface ExampleView {
  id: string;
  kindLabel: string;
  /** The canonical phrase of a phrase row, shown until its reply is read. */
  phrase: string | null;
  hasText: boolean;
  /** What happened, in one sentence, for a self-correction with no reply to show. */
  summary: string;
  /** "After update_task failed", "Before any tool call". */
  context: string;
  occurredAt: string;
  traceHref: string;
}

/** What a fix is about: a tool or a skill by its catalog id, or a task. */
export type FixSubjectView =
  | { kind: "tool"; id: string; entryKind: "tool" | "skill"; name: string; href: string }
  | { kind: "task"; id: string; name: string; color: TaskColorSlot | null; href: string };

export interface FixView {
  /** The issue's id. */
  id: string;
  fix: string;
  why: string;
  reason: string;
  /** Fixes, narrowed to its tool, task or intent. */
  fixesHref: string;
  issueHref: string;
  pattern: FixPattern;
  subject: FixSubjectView;
  /** The catalog tool whose searchable description the fix updates; null for every other fix. */
  descriptionTool: string | null;
}

export interface FilterView {
  field: "tool" | "task" | "topic";
  label: string;
  value: string;
  removeHref: string;
  /** The thing itself: the tool on Catalog, the task's page, the intent on Intents. */
  href: string;
}

export interface SelfCorrectionsPageModel {
  projectId: string;
  state: PageState;
  windowDays: WindowDays;
  computedAt: string | null;
  filters: readonly FilterView[];
  turns: number;
  events: number;
  stats: readonly StatView[];
  /** Per 100 turns over the window; null when its buckets were not read or no turn ended. */
  trend: TrendView | null;
  byKind: readonly KindRow[];
  byTool: readonly ToolRow[];
  /** Self-corrections with no tool call before them. */
  withoutTool: number;
  byTask: readonly TaskRow[];
  /** Self-corrections in turns no task handles. */
  unplaced: { events: number; turns: number };
  /** By intent; null when no turn has an intent yet. */
  byTopic: readonly TopicRow[] | null;
  phrases: { captured: boolean; top: readonly PhraseRow[] };
  examples: readonly ExampleView[];
  fixes: readonly FixView[];
}

const TOP_ROWS = 8;
const TOP_FIXES = 5;
/** Daily buckets up to this many days in the window; a week per bucket beyond it. */
export const TREND_DAILY_UP_TO = 30;
const UNNAMED_INTENT = "Unnamed intent";
/** Turns on each side before the sentiment multiplier is shown. */
export const SENTIMENT_MIN_TURNS = 20;
/** Turns the window before needs before the rate is compared with it: a handful of turns is no baseline. */
export const PREVIOUS_MIN_TURNS = 20;

const plural = (n: number, one: string, many: string) =>
  `${formatCount(n)} ${n === 1 ? one : many}`;

/** A rate per 100 turns, one decimal. */
export function formatRate(rate: number): string {
  return (Math.round(rate * 10) / 10).toFixed(1);
}

const byEventsThenKey =
  <T extends { events: number }>(key: (row: T) => string) =>
  (a: T, b: T) =>
    b.events - a.events || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** Events summed by key; null keys are left out. */
function sumBy<T extends { events: number }>(
  items: readonly T[],
  keyOf: (item: T) => string | null,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    if (key !== null) out.set(key, (out.get(key) ?? 0) + item.events);
  }
  return out;
}

const plainOf = (group: Pick<CorrectionGroup, "kind" | "phraseCategory">) =>
  plainKindOf(group.kind, group.phraseCategory);

/** Days per trend bucket for a window. */
export function trendBucketDays(windowDays: number): number {
  return windowDays <= TREND_DAILY_UP_TO ? 1 : 7;
}

/** The window's rate per 100 turns, bucket by bucket; null when no bucket has a turn. */
export function trendOf(
  windowDays: number,
  buckets: readonly BucketCount[] | undefined,
): TrendView | null {
  if (!buckets || buckets.length === 0) return null;
  const bucketDays = trendBucketDays(windowDays);
  const count = Math.max(1, Math.ceil(windowDays / bucketDays));
  const at = new Map(buckets.map((row) => [row.bucket, row]));
  const values = Array.from({ length: count }, (_, index) => {
    const row = at.get(index);
    return row && row.turns > 0 ? Math.round(((row.events * 100) / row.turns) * 10) / 10 : null;
  });
  if (values.every((value) => value === null)) return null;
  return {
    values,
    bucketDays,
    label: bucketDays === 1 ? "Per 100 turns, day by day" : "Per 100 turns, week by week",
  };
}

function rateStat(windowDays: number, reads: CorrectionReads, events: number): StatView {
  const turns = reads.current.turns;
  const rate = turns > 0 ? (events * 100) / turns : null;
  const before =
    reads.previous && reads.previous.turns >= PREVIOUS_MIN_TURNS
      ? (reads.previous.events * 100) / reads.previous.turns
      : null;
  const delta = rate !== null && before !== null ? Math.round((rate - before) * 10) / 10 : null;
  const span = windowDays === 1 ? "day" : `${windowDays} days`;
  const stat: StatView = {
    label: "Per 100 turns",
    value: rate === null ? "0.0" : formatRate(rate),
    hint:
      before !== null
        ? `${formatRate(before)} in the ${span} before`
        : `${formatCount(events)} in ${plural(turns, "turn", "turns")}`,
  };
  if (delta === null) return stat;
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  // More self-corrections is worse for the reader.
  const good = delta === 0 ? null : delta < 0;
  return {
    ...stat,
    delta: {
      value: `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`,
      direction,
      good,
      label: `vs the ${span} before`,
    },
  };
}

function stats(
  windowDays: number,
  reads: CorrectionReads,
  kinds: ReadonlyMap<SelfCorrectionKind | "phrase", number>,
  events: number,
): StatView[] {
  const { failedCalls, recoveredCalls, turns } = reads.current;
  const asked = kinds.get("asked_again") ?? 0;
  const gaveUp = kinds.get("gave_up_after_error") ?? 0;
  const sessions = reads.run?.trust.sessions ?? true;
  const out: StatView[] = [
    rateStat(windowDays, reads, events),
    {
      label: "Recovered",
      value: failedCalls > 0 ? formatSharePercent(recoveredCalls / failedCalls) : "No errors",
      hint:
        failedCalls > 0
          ? `${formatCount(recoveredCalls)} of ${plural(failedCalls, "failed call", "failed calls")}`
          : "No tool call failed",
    },
    sessions
      ? {
          label: "Asked again next turn",
          value: turns > 0 ? formatSharePercent(asked / turns) : "0%",
          hint: `${formatCount(asked)} of ${plural(turns, "turn", "turns")}`,
        }
      : {
          label: "Asked again next turn",
          value: "Not measured",
          hint: "Runs from different people are mixed in one session",
        },
    {
      label: "Gave up",
      value: formatCount(gaveUp),
      hint:
        failedCalls > 0
          ? `${formatSharePercent(gaveUp / failedCalls)} of failed calls`
          : "No tool call failed",
    },
  ];
  const sentiment = reads.sentiment;
  if (
    sentiment &&
    sentiment.corrected.measured >= SENTIMENT_MIN_TURNS &&
    sentiment.clean.measured >= SENTIMENT_MIN_TURNS &&
    sentiment.clean.negative > 0
  ) {
    const corrected = sentiment.corrected.negative / sentiment.corrected.measured;
    const clean = sentiment.clean.negative / sentiment.clean.measured;
    out.push({
      label: "Negative after one",
      value: `${(Math.round((corrected / clean) * 10) / 10).toFixed(1)}×`,
      hint: `${formatSharePercent(corrected)} of turns with a self-correction, ${formatSharePercent(clean)} without`,
    });
  }
  return out;
}

function kindRows(groups: readonly CorrectionGroup[], events: number, replies: boolean): KindRow[] {
  const counts = new Map<PlainKind, number>();
  for (const group of groups) {
    const plain = plainOf(group);
    if (plain) counts.set(plain, (counts.get(plain) ?? 0) + group.events);
  }
  const phrase = new Set<PlainKind>(["apologized", "conceded", "backtracked"]);
  return PLAIN_KINDS.map((kind) => {
    const n = counts.get(kind) ?? 0;
    return {
      kind,
      label: PLAIN_KIND_LABELS[kind],
      events: n,
      share: events > 0 ? n / events : 0,
      measured: !phrase.has(kind) || replies || n > 0,
    };
  });
}

function toolName(names: CorrectionNames, node: string): string {
  const entry = catalogEntryOf(node);
  return names.tools.get(entry.id) ?? entry.id;
}

function taskName(names: CorrectionNames, id: string): string {
  return names.tasks.get(id)?.name ?? id;
}

/** The plain kind with the most events among these groups; ties in `PLAIN_KINDS` order. */
function mainKind(groups: readonly CorrectionGroup[]): PlainKind | null {
  const counts = new Map<PlainKind, number>();
  for (const group of groups) {
    const plain = plainOf(group);
    if (plain) counts.set(plain, (counts.get(plain) ?? 0) + group.events);
  }
  return PLAIN_KINDS.reduce<PlainKind | null>(
    (best, kind) => ((counts.get(kind) ?? 0) > (best ? (counts.get(best) ?? 0) : 0) ? kind : best),
    null,
  );
}

function toolRows(
  input: BuildInput,
  groups: readonly CorrectionGroup[],
  events: number,
): ToolRow[] {
  const { projectId, names, windowDays, filters } = input;
  const totals = sumBy(groups, (g) => g.toolId);
  return [...totals]
    .map(([node, n]) => ({ node, events: n }))
    .sort(byEventsThenKey((row) => row.node))
    .slice(0, TOP_ROWS)
    .map(({ node, events: n }) => {
      const mine = groups.filter((g) => g.toolId === node);
      const tasks = [...sumBy(mine, (g) => g.workflowId)].sort(
        (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
      );
      const task = tasks[0]?.[0];
      const kind = mainKind(mine);
      const entry = catalogEntryOf(node);
      return {
        node,
        entryId: entry.id,
        entryKind: entry.kind,
        name: toolName(names, node),
        events: n,
        share: events > 0 ? n / events : 0,
        mainKind: kind ? PLAIN_KIND_LABELS[kind] : "",
        filterHref: selfCorrectionsHref(projectId, {
          days: windowDays,
          filters: { ...filters, tool: node },
        }),
        catalogHref: catalogHref(projectId, node),
        task: task
          ? { id: task, name: taskName(names, task), href: taskHref(projectId, task) }
          : null,
      };
    });
}

/** The busiest tasks' colors, as every page gives them. */
function colorsOf(names: CorrectionNames): Map<string, TaskColorSlot> {
  return taskColors([...names.tasks].map(([id, task]) => ({ id, runs: task.runs })));
}

function taskRows(
  input: BuildInput,
  groups: readonly CorrectionGroup[],
  events: number,
  turnsByTask: ReadonlyMap<string, number>,
): TaskRow[] {
  const { projectId, names, windowDays, filters } = input;
  const colors = colorsOf(names);
  const totals = sumBy(groups, (g) => g.workflowId);
  return [...totals]
    .map(([id, n]) => {
      const turns = turnsByTask.get(id) ?? 0;
      return {
        id,
        name: taskName(names, id),
        color: colors.get(id) ?? null,
        events: n,
        turns,
        per100: turns > 0 ? (n * 100) / turns : null,
        share: events > 0 ? n / events : 0,
        href: taskHref(projectId, id),
        filterHref: selfCorrectionsHref(projectId, {
          days: windowDays,
          filters: { ...filters, task: id },
        }),
      };
    })
    .sort(byEventsThenKey((row) => row.id))
    .slice(0, TOP_ROWS);
}

function topicRows(
  input: BuildInput,
  groups: readonly CorrectionGroup[],
  events: number,
  turnsByTopic: ReadonlyMap<string, number>,
): TopicRow[] | null {
  const { projectId, names, windowDays, filters } = input;
  const totals = sumBy(groups, (g) => g.topicId);
  if (totals.size === 0 && turnsByTopic.size === 0) return null;
  return [...totals]
    .map(([id, n]) => {
      const turns = turnsByTopic.get(id) ?? 0;
      return {
        id,
        name: names.topics.get(id) ?? UNNAMED_INTENT,
        events: n,
        turns,
        per100: turns > 0 ? (n * 100) / turns : null,
        share: events > 0 ? n / events : 0,
        href: topicHref(projectId, id),
        filterHref: selfCorrectionsHref(projectId, {
          days: windowDays,
          filters: { ...filters, topic: id },
        }),
      };
    })
    .sort(byEventsThenKey((row) => row.id))
    .slice(0, TOP_ROWS);
}

function phraseRows(groups: readonly CorrectionGroup[]): PhraseRow[] {
  const phrases = groups.filter((g) => g.kind === "phrase" && g.phrase);
  const total = phrases.reduce((sum, g) => sum + g.events, 0);
  const byPhrase = new Map<string, { events: number; plain: PlainKind | null }>();
  for (const group of phrases) {
    const known = byPhrase.get(group.phrase!);
    byPhrase.set(group.phrase!, {
      events: (known?.events ?? 0) + group.events,
      plain: known?.plain ?? plainOf(group),
    });
  }
  return [...byPhrase]
    .map(([phrase, { events, plain }]) => ({
      phrase,
      kindLabel: plain ? PLAIN_KIND_LABELS[plain] : "",
      events,
      share: total > 0 ? events / total : 0,
    }))
    .sort(byEventsThenKey((row) => row.phrase))
    .slice(0, TOP_ROWS);
}

const OTLP_TURN = "otlp:";

/** Traces for one example: the run's waterfall when it is one trace, else its turn with the step in focus. */
export function exampleTraceHref(
  projectId: string,
  example: Pick<CorrectionExample, "turnId" | "turnKey" | "focusEventId">,
): string {
  const base = `/project/${encodeURIComponent(projectId)}/traces`;
  if (example.turnKey.startsWith(OTLP_TURN) && example.turnKey.length > OTLP_TURN.length) {
    return `${base}/${encodeURIComponent(example.turnKey.slice(OTLP_TURN.length))}`;
  }
  const turn = `${base}/turns/${encodeURIComponent(example.turnId)}`;
  return example.focusEventId ? `${turn}?focus=${encodeURIComponent(example.focusEventId)}` : turn;
}

function exampleContext(names: CorrectionNames, example: CorrectionExample): string {
  if (!example.toolId) return "Before any tool call";
  const tool = toolName(names, example.toolId);
  if (example.toolOutcome === "error") return `After ${tool} failed`;
  return `After ${tool}`;
}

/** One sentence for what a self-correction was, from its kind and the call before it. */
function exampleSummary(
  names: CorrectionNames,
  example: CorrectionExample,
  plain: PlainKind | null,
): string {
  const tool = example.toolId ? toolName(names, example.toolId) : null;
  switch (plain) {
    case "retried":
      return `${tool ?? "A tool"} failed, and the agent called it again.`;
    case "switched":
      return `${tool ?? "A tool"} failed, and the agent tried another tool.`;
    case "gave_up":
      return `${tool ?? "A tool"} failed, and the agent stopped there.`;
    case "searched_again":
      return tool
        ? `After ${tool}, the agent searched again for the same thing.`
        : "The agent searched again for the same thing.";
    case "asked_again":
      return "The person asked the same thing again in their next message.";
    default:
      return example.phrase ? `The agent said “${example.phrase}”.` : "The agent corrected itself.";
  }
}

function exampleViews(input: BuildInput): ExampleView[] {
  return input.reads.examples.map((example) => {
    const plain = plainKindOf(example.kind, example.phraseCategory);
    return {
      id: example.id,
      kindLabel: plain ? PLAIN_KIND_LABELS[plain] : "Self-correction",
      phrase: example.phrase,
      hasText: example.hasText,
      summary: exampleSummary(input.names, example, plain),
      context: exampleContext(input.names, example),
      occurredAt: example.occurredAt.toISOString(),
      traceHref: exampleTraceHref(input.projectId, example),
    };
  });
}

/** The catalog tool a fix updates the searchable description of: a backtrack's tool, never a skill. */
function descriptionToolOf(issue: CorrectionIssue): string | null {
  if (issue.pattern !== "backtrack") return null;
  const node = issue.fixTool ?? (issue.subjectKind === "workflow" ? null : issue.subjectKey);
  if (!node) return null;
  const entry = catalogEntryOf(node);
  return entry.kind === "tool" ? entry.id : null;
}

function fixSubject(
  input: BuildInput,
  issue: CorrectionIssue,
  colors: ReadonlyMap<string, TaskColorSlot>,
): FixSubjectView {
  if (issue.subjectKind === "workflow") {
    return {
      kind: "task",
      id: issue.subjectKey,
      name: taskName(input.names, issue.subjectKey),
      color: colors.get(issue.subjectKey) ?? null,
      href: taskHref(input.projectId, issue.subjectKey),
    };
  }
  const entry = catalogEntryOf(issue.subjectKey);
  return {
    kind: "tool",
    id: entry.id,
    entryKind: entry.kind,
    name: toolName(input.names, issue.subjectKey),
    href: catalogHref(input.projectId, issue.subjectKey),
  };
}

/**
 * The fixes of the open issues, worst first; a fix the same as a worse one's
 * (a tool and its task) is shown once. On a tie the tool's issue goes first,
 * the more specific subject, so the link never depends on random ids.
 */
function fixViews(input: BuildInput, colors: ReadonlyMap<string, TaskColorSlot>): FixView[] {
  const { projectId, reads } = input;
  const onTask = (issue: CorrectionIssue) => Number(issue.subjectKind === "workflow");
  return [...reads.issues]
    .sort((a, b) => b.severity - a.severity || onTask(a) - onTask(b) || (a.id < b.id ? -1 : 1))
    .filter(
      (issue, index, sorted) => sorted.findIndex((other) => other.fix === issue.fix) === index,
    )
    .slice(0, TOP_FIXES)
    .map((issue) => {
      const task = issue.subjectKind === "workflow";
      const scope = task
        ? {
            task: issue.subjectKey,
            ...(issue.pattern === "unanswered" && issue.topicId ? { topic: issue.topicId } : {}),
          }
        : { tool: issue.subjectKey };
      return {
        id: issue.id,
        fix: issue.fix,
        why: issue.claim,
        reason: PATTERN_REASONS[issue.pattern],
        fixesHref: fixesHref(projectId, scope),
        issueHref: `/project/${encodeURIComponent(projectId)}/health#signal-${issue.id}`,
        pattern: issue.pattern,
        subject: fixSubject(input, issue, colors),
        descriptionTool: descriptionToolOf(issue),
      };
    });
}

function filterViews(input: BuildInput): FilterView[] {
  const { projectId, windowDays, filters, names } = input;
  const without = (field: keyof SelfCorrectionFilters) =>
    selfCorrectionsHref(projectId, { days: windowDays, filters: { ...filters, [field]: null } });
  const out: FilterView[] = [];
  if (filters.tool) {
    out.push({
      field: "tool",
      label: "After",
      value: toolName(names, filters.tool),
      removeHref: without("tool"),
      href: catalogHref(projectId, filters.tool),
    });
  }
  if (filters.task)
    out.push({
      field: "task",
      label: "Task",
      value: taskName(names, filters.task),
      removeHref: without("task"),
      href: taskHref(projectId, filters.task),
    });
  if (filters.topic) {
    out.push({
      field: "topic",
      label: "Intent",
      value: names.topics.get(filters.topic) ?? UNNAMED_INTENT,
      removeHref: without("topic"),
      href: topicHref(projectId, filters.topic),
    });
  }
  return out;
}

export interface BuildInput {
  projectId: string;
  windowDays: WindowDays;
  filters: SelfCorrectionFilters;
  reads: CorrectionReads;
  names: CorrectionNames;
}

function stateOf(reads: CorrectionReads): PageState {
  if (!reads.run) return "not_read";
  if (reads.run.trust.runs === "none") return "mixed_runs";
  return reads.current.turns > 0 ? "ready" : "no_turns";
}

export function buildSelfCorrectionsPage(input: BuildInput): SelfCorrectionsPageModel {
  const { reads } = input;
  const groups = reads.current.groups;
  const events = groups.reduce((sum, group) => sum + group.events, 0);
  const kinds = new Map<SelfCorrectionKind | "phrase", number>();
  for (const group of groups)
    kinds.set(
      group.kind as SelfCorrectionKind,
      (kinds.get(group.kind as SelfCorrectionKind) ?? 0) + group.events,
    );
  const taskTotals = [...reads.taskTurns.values()].reduce((sum, n) => sum + n, 0);
  const unplacedEvents = groups
    .filter((g) => g.workflowId === null)
    .reduce((sum, g) => sum + g.events, 0);
  return {
    projectId: input.projectId,
    state: stateOf(reads),
    windowDays: input.windowDays,
    computedAt: reads.run?.computedAt ?? null,
    filters: filterViews(input),
    turns: reads.current.turns,
    events,
    stats: stats(input.windowDays, reads, kinds, events),
    trend: trendOf(input.windowDays, reads.buckets),
    byKind: kindRows(groups, events, (reads.run?.turnsWithReplies ?? 0) > 0),
    byTool: toolRows(input, groups, events),
    withoutTool: groups.filter((g) => g.toolId === null).reduce((sum, g) => sum + g.events, 0),
    byTask: taskRows(input, groups, events, reads.taskTurns),
    unplaced: { events: unplacedEvents, turns: Math.max(0, reads.current.turns - taskTotals) },
    byTopic: topicRows(input, groups, events, reads.topicTurns),
    phrases: { captured: (reads.run?.turnsWithReplies ?? 0) > 0, top: phraseRows(groups) },
    examples: exampleViews(input),
    fixes: fixViews(input, colorsOf(input.names)),
  };
}
