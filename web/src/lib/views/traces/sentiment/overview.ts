import {
  FRICTION_REASONS,
  type FrictionReason,
  TASK_REASONS,
  type TaskReason,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import {
  CAUSE_OWNER,
  DISSATISFACTION_GROUPS,
  type DissatisfactionGroup,
  dissatisfactionGroupOf,
  type RootCause,
} from "@/lib/views/traces/sentiment/page-kinds";
import type {
  Occurrence,
  PageAnswer,
  PageTask,
  ReadBy,
} from "@/lib/views/traces/sentiment/page-model";
import {
  type SentimentFilters,
  type SentimentSort,
  TASK_FILTERS,
  type TaskFilter,
  taskFilterOf,
} from "@/lib/views/traces/sentiment/page-paths";

/**
 * The Sentiment analysis page's answer, in the order it reads (pure):
 *   1. is the work getting done: tasks completed;
 *   2. are people satisfied: satisfied of the turns they said how it went
 *      (their own words, else what the agent's next reply shows, counted apart);
 *   3. how satisfied people were in each task status;
 *   4. why tasks were not completed, and what got in the way of the ones
 *      completed after friction: one group per reason;
 *   5. the root causes inside each group (a cause and a tool), counted once
 *      per task, with what those tasks cost and how long they took, groups
 *      and rows in the order asked for;
 *   6. satisfaction day by day, as an average over the days before each.
 * Every number is over the tasks in scope: the window's tasks under the
 * intent, session-outcome and week filters, less the ones whose result can't
 * be told, which the page leaves out.
 */

/** Rows listed per reason; the rest are counted and one click away (the reason's filter, under which every row shows). */
export const REASON_ROWS = 8;

export type GroupResult = "not_completed" | "completed_after_friction";

/**
 * Whether a root cause could have been avoided, and by whom: the agent's own
 * team (its prompt and tool descriptions), the tool's owner, the
 * integration setup, a tool that does not exist yet, or nobody (the agent
 * was right, or the request was unclear). Unknown when no cause was named.
 */
export type Avoidability =
  | "agent"
  | "tool_owner"
  | "setup"
  | "new_tool"
  | "not_avoidable"
  | "unknown";

export function avoidabilityOf(cause: RootCause | null): Avoidability {
  if (cause === null) return "unknown";
  switch (CAUSE_OWNER[cause]) {
    case "prompt":
      return "agent";
    case "tool_owner":
      return "tool_owner";
    case "integration_setup":
      return "setup";
    case "roadmap":
      return "new_tool";
    case "nobody":
      return "not_avoidable";
  }
}

/** A few of a root cause's tasks, newest first, to open in Traces. */
export interface TaskExample {
  taskId: string;
  sessionId: string;
  /** Its turns in order: each opens in Traces. */
  turnIds: string[];
  /** The turn the root cause happened in (the task's last turn when no cause was named): the one to show. */
  turnId: string;
  endedAt: string;
  /** For a task completed after friction, the turns before the one that finished it. */
  extraTurns: number | null;
}

/** Examples kept per root cause. */
export const ROW_EXAMPLES = 5;

export interface ReasonRow {
  key: string;
  /** Null for the tasks of the reason where nothing went wrong in a way the trace or a model named. */
  cause: RootCause | null;
  tool: string | null;
  readBy: ReadBy;
  tasks: number;
  sessions: number;
  /**
   * What its tasks cost: a task not completed counts whole (all of it was
   * spent for nothing); a task completed after friction counts only its extra
   * turns, the cost of the friction. Null when the window holds no costed call.
   */
  costUsd: number | null;
  /** The tokens the same model calls used; null when none was sent with them. */
  tokens: number | null;
  /** How long the same turns took, added up. */
  timeMs: number;
  /** Turns spent before the one that finished, over its tasks completed after friction. */
  extraTurns: number;
  lastSeen: string | null;
  avoidable: Avoidability;
  examples: TaskExample[];
}

export interface ReasonGroup {
  key: string;
  result: GroupResult;
  reason: TaskReason | FrictionReason;
  tasks: number;
  sessions: number;
  costUsd: number | null;
  tokens: number | null;
  timeMs: number;
  extraTurns: number;
  lastSeen: string | null;
  rows: ReasonRow[];
  /** Rows past `REASON_ROWS`. */
  moreRows: number;
}

/** The share of dissatisfaction the "vital few" problems add up to (a Pareto cut). */
export const PARETO_CUT = 0.8;

/** One problem behind unsatisfied turns: a cause (on whichever tool), or none named. */
export interface DissatisfactionProblem {
  key: string;
  cause: RootCause | null;
  /** The tools it happened on, most turns first. */
  tools: Array<{ tool: string; turns: number }>;
  /** Unsatisfied turns it is behind. */
  turns: number;
  share: number;
  /** This problem's share and every larger one's, added up. */
  cumulative: number;
  /** Among the fewest problems that add up to `PARETO_CUT`. */
  vital: boolean;
  /** Its newest unsatisfied turns, at most `PARETO_EXAMPLES`: where to look in Traces. */
  examples: Array<{ turnId: string; endedAt: string | null }>;
}

/** One group of dissatisfaction (agent, system and operations, other): its unsatisfied turns and their share. */
export interface DissatisfactionGroupTotal {
  group: DissatisfactionGroup;
  turns: number;
  share: number;
}

/** Unsatisfied turns kept per cause, to open in Traces. */
export const PARETO_EXAMPLES = 10;

/** Days the satisfaction line averages over, the day itself and the ones before it. */
export const SMOOTHING_DAYS = 7;

export interface DayPoint {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** Turns people said how it went that day, and the satisfied ones. */
  answers: number;
  satisfied: number;
  /**
   * Satisfied of the turns people said how it went over the last
   * `SMOOTHING_DAYS` days to this one: a day of one or two answers would
   * swing the line from 0% to 100%. Null with no answer in those days.
   */
  satisfaction: number | null;
  /** The answers that average stands on. */
  windowAnswers: number;
}

export interface Overview {
  tasks: number;
  completed: number;
  notCompleted: number;
  completion: number | null;
  satisfaction: { score: number | null; answers: number; satisfied: number; inferred: number };
  statuses: Array<{
    filter: TaskFilter;
    tasks: number;
    share: number;
    score: number | null;
    answers: number;
  }>;
  groups: ReasonGroup[];
  /**
   * Every reason the tasks in scope have, by result, most first: the choices
   * above the reasons table. Counted before the task, reason, cause and tool
   * filters, so picking one never hides the others.
   */
  reasons: Array<{ result: GroupResult; reason: TaskReason | FrictionReason; tasks: number }>;
  /**
   * The causes and tools the root causes hold under the task and reason
   * filters, most tasks first: what a cause or tool filter can add. Counted
   * before the cause and tool filters, so picking one keeps the others.
   */
  options: {
    causes: Array<{ cause: RootCause; tasks: number }>;
    tools: Array<{ tool: string; tasks: number }>;
  };
  /** The tasks not completed, whole: what failure cost. */
  failure: { tasks: number; costUsd: number | null; tokens: number | null; timeMs: number };
  /**
   * The tasks completed after friction: their extra turns and retried calls,
   * what those cost and took, the tasks whose friction stayed inside one turn,
   * and the part a fix could have avoided.
   */
  friction: {
    tasks: number;
    extraTurns: number;
    /** Calls that failed and were tried again in the turn that finished the task. */
    retriedCalls: number;
    inTurn: number;
    costUsd: number | null;
    tokens: number | null;
    timeMs: number;
    avoidable: { tasks: number; costUsd: number | null; tokens: number | null; timeMs: number };
  };
  daily: DayPoint[];
  /**
   * The problems behind unsatisfied turns, most first (a Pareto list): each
   * unsatisfied turn counts once, for the problem found in it (or elsewhere in
   * its task when the turn itself shows none).
   */
  dissatisfaction: {
    turns: number;
    problems: DissatisfactionProblem[];
    vital: number;
    groups: DissatisfactionGroupTotal[];
  };
  costKnown: boolean;
}

const DAY_MS = 86_400_000;
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);
const share = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);
const COMPLETED: readonly TaskFilter[] = ["completed", "completed_after_friction"];

const reasonOf = (task: PageTask): TaskReason | FrictionReason | null =>
  (task.result === "not_completed"
    ? TASK_REASONS
    : task.result === "completed_after_friction"
      ? FRICTION_REASONS
      : []
  ).find((known) => known === task.reason) ?? null;

/** What groups and rows are ordered by. `impact` (the default) is the tasks a row or group holds. */
type Ranked = Pick<
  ReasonRow,
  "tasks" | "sessions" | "costUsd" | "tokens" | "timeMs" | "extraTurns" | "lastSeen"
>;
const ORDER: Record<SentimentSort, (a: Ranked, b: Ranked) => number> = {
  impact: (a, b) => b.tasks - a.tasks || b.sessions - a.sessions,
  sessions: (a, b) => b.sessions - a.sessions || b.tasks - a.tasks,
  share: (a, b) => b.tasks - a.tasks,
  // What it cost, in tokens first: they are sent more often than a price.
  cost: (a, b) =>
    (b.tokens ?? 0) - (a.tokens ?? 0) || (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.tasks - a.tasks,
  time: (a, b) => b.timeMs - a.timeMs || b.tasks - a.tasks,
  recent: (a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "") || b.tasks - a.tasks,
};

interface Hit {
  task: PageTask;
  /** The turn it happened in; null for a task no cause was named for. */
  turnId: string | null;
  cause: RootCause | null;
  tool: string | null;
  source: ReadBy;
}

/** What a task spent on its trouble: all of it when not completed, its extra turns when completed after friction. */
function spentOf(task: PageTask): {
  costUsd: number;
  tokens: number | null;
  timeMs: number;
  extraTurns: number;
} {
  if (task.result === "completed_after_friction") {
    return {
      costUsd: task.friction?.costUsd ?? 0,
      tokens: task.friction?.tokens ?? null,
      timeMs: task.friction?.timeMs ?? 0,
      extraTurns: task.friction?.extraTurns ?? 0,
    };
  }
  return {
    costUsd: task.costUsd ?? 0,
    tokens: task.tokens,
    timeMs: Math.max(0, task.endedAt.getTime() - task.startedAt.getTime()),
    extraTurns: 0,
  };
}

/** Tokens added up; null when none of them was sent. */
const sumTokens = (values: ReadonlyArray<number | null>): number | null =>
  values.some((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;

/** Hits counted by task: a task in two of them counts once, with what it spent. */
function tally(hits: readonly Hit[], costKnown: boolean): Ranked & { readBy: ReadBy } {
  const tasks = new Map(hits.map((hit) => [hit.task.taskId, hit.task]));
  let costUsd = 0;
  let timeMs = 0;
  let extraTurns = 0;
  const tokens: Array<number | null> = [];
  let last: Date | null = null;
  for (const task of tasks.values()) {
    const spent = spentOf(task);
    costUsd += spent.costUsd;
    tokens.push(spent.tokens);
    timeMs += spent.timeMs;
    extraTurns += spent.extraTurns;
    if (last === null || task.endedAt > last) last = task.endedAt;
  }
  const rule = hits.some((hit) => hit.source !== "model");
  const model = hits.some((hit) => hit.source !== "rule");
  return {
    tasks: tasks.size,
    sessions: new Set([...tasks.values()].map((task) => task.sessionId)).size,
    costUsd: costKnown ? costUsd : null,
    tokens: sumTokens(tokens),
    timeMs,
    extraTurns,
    lastSeen: last?.toISOString() ?? null,
    readBy: model && rule ? "mixed" : model ? "model" : "rule",
  };
}

/** A root cause's newest tasks, each once. */
function examplesOf(hits: readonly Hit[]): TaskExample[] {
  const tasks = [...new Map(hits.map((hit) => [hit.task.taskId, hit.task])).values()];
  // The task's latest turn the cause happened in.
  const turnOf = new Map<string, string>();
  for (const hit of hits) {
    if (!hit.turnId) continue;
    const seen = turnOf.get(hit.task.taskId);
    if (seen === undefined || hit.task.turnIds.indexOf(hit.turnId) > hit.task.turnIds.indexOf(seen))
      turnOf.set(hit.task.taskId, hit.turnId);
  }
  return tasks
    .sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime() || a.taskId.localeCompare(b.taskId))
    .slice(0, ROW_EXAMPLES)
    .map((task) => ({
      taskId: task.taskId,
      sessionId: task.sessionId,
      turnIds: [...task.turnIds],
      turnId: turnOf.get(task.taskId) ?? task.turnIds.at(-1) ?? task.taskId,
      endedAt: task.endedAt.toISOString(),
      extraTurns:
        task.result === "completed_after_friction" ? (task.friction?.extraTurns ?? 0) : null,
    }));
}

export function buildOverview(input: {
  /** The window's tasks in scope. */
  tasks: readonly PageTask[];
  answers: readonly PageAnswer[];
  /** What went wrong in the window's turns (`occurrencesOf`). */
  occurrences: readonly Pick<Occurrence, "turn" | "cause" | "tool" | "source">[];
  filters: SentimentFilters;
  sort: SentimentSort;
  costKnown: boolean;
  now: Date;
  windowDays: number;
}): Overview {
  const { filters } = input;
  // A task whose result can't be told is left off the page.
  const tasks = input.tasks.filter((task) => taskFilterOf(task) !== null);
  const taskOfTurn = new Map<string, PageTask>();
  for (const task of tasks) for (const turnId of task.turnIds) taskOfTurn.set(turnId, task);
  const answers = input.answers.filter((answer) => taskOfTurn.has(answer.turnId));
  const answersOf = (keep: (task: PageTask) => boolean) =>
    answers.filter((answer) => keep(taskOfTurn.get(answer.turnId)!));
  const scoreOf = (list: readonly PageAnswer[]) =>
    share(list.filter((answer) => answer.satisfied).length, list.length);

  const filterOf = new Map(tasks.map((task) => [task.taskId, taskFilterOf(task)]));
  const completed = tasks.filter((task) => COMPLETED.includes(filterOf.get(task.taskId)!)).length;

  const statuses = TASK_FILTERS.map((filter) => {
    const inStatus = tasks.filter((task) => filterOf.get(task.taskId) === filter);
    const said = answersOf((task) => filterOf.get(task.taskId) === filter);
    return {
      filter,
      tasks: inStatus.length,
      share: share(inStatus.length, tasks.length) ?? 0,
      score: scoreOf(said),
      answers: said.length,
    };
  });

  // Root causes, by the reason of the task they happened in.
  const hits: Hit[] = [];
  const explained = new Set<string>();
  for (const occurrence of input.occurrences) {
    const task = taskOfTurn.get(occurrence.turn.turnId);
    if (!task || !reasonOf(task)) continue;
    explained.add(task.taskId);
    // A turn that went wrong with every call working names no cause: it joins the tasks nothing was found for.
    hits.push({
      task,
      turnId: occurrence.turn.turnId,
      cause: occurrence.cause === "no_failure" ? null : occurrence.cause,
      tool: occurrence.tool,
      source: occurrence.source,
    });
  }
  for (const task of tasks)
    if (reasonOf(task) && !explained.has(task.taskId))
      hits.push({ task, turnId: null, cause: null, tool: null, source: "rule" });
  const inReason = hits.filter((hit) => {
    if (filters.task !== null && filterOf.get(hit.task.taskId) !== filters.task) return false;
    if (filters.reason !== null && hit.task.reason !== filters.reason) return false;
    return true;
  });
  const kept = inReason.filter(
    (hit) =>
      (filters.cause === null || hit.cause === filters.cause) &&
      (filters.tool === null || hit.tool === filters.tool),
  );
  const countBy = <K extends string>(keyOf: (hit: Hit) => K | null) => {
    const tasksOf = new Map<K, Set<string>>();
    for (const hit of inReason) {
      const key = keyOf(hit);
      if (key === null) continue;
      tasksOf.set(key, (tasksOf.get(key) ?? new Set()).add(hit.task.taskId));
    }
    return [...tasksOf]
      .map(([key, ids]) => ({ key, tasks: ids.size }))
      .sort((a, b) => b.tasks - a.tasks || a.key.localeCompare(b.key));
  };
  const options = {
    causes: countBy((hit) => hit.cause).map(({ key, tasks }) => ({ cause: key, tasks })),
    tools: countBy((hit) => hit.tool).map(({ key, tasks }) => ({ tool: key, tasks })),
  };
  const order = ORDER[input.sort];
  const cap = filters.reason === null ? REASON_ROWS : Number.POSITIVE_INFINITY;
  const byGroup = new Map<string, Hit[]>();
  for (const hit of kept) {
    const key = `${hit.task.result}:${hit.task.reason}`;
    byGroup.set(key, [...(byGroup.get(key) ?? []), hit]);
  }
  const groups = [...byGroup].map(([key, list]): ReasonGroup => {
    const byRow = new Map<string, Hit[]>();
    for (const hit of list) {
      const rowKey = `${hit.cause ?? ""}|${hit.tool ?? ""}`;
      byRow.set(rowKey, [...(byRow.get(rowKey) ?? []), hit]);
    }
    const rows = [...byRow]
      .map(
        ([rowKey, rowHits]): ReasonRow => ({
          key: rowKey,
          cause: rowHits[0]!.cause,
          tool: rowHits[0]!.tool,
          ...tally(rowHits, input.costKnown),
          avoidable: avoidabilityOf(rowHits[0]!.cause),
          examples: examplesOf(rowHits),
        }),
      )
      .sort((a, b) => order(a, b) || a.key.localeCompare(b.key));
    const { readBy: _readBy, ...totals } = tally(list, input.costKnown);
    return {
      key,
      result: list[0]!.task.result as GroupResult,
      reason: reasonOf(list[0]!.task)!,
      ...totals,
      rows: rows.slice(0, cap),
      moreRows: Math.max(0, rows.length - cap),
    };
  });
  // Not completed first, then the friction before completion; each part in the order asked for.
  groups.sort(
    (a, b) =>
      (a.result === b.result ? 0 : a.result === "not_completed" ? -1 : 1) ||
      order(a, b) ||
      a.key.localeCompare(b.key),
  );

  const reasonCounts = new Map<
    string,
    { result: GroupResult; reason: TaskReason | FrictionReason; tasks: number }
  >();
  for (const task of tasks) {
    const reason = reasonOf(task);
    if (!reason) continue;
    const key = `${task.result}:${reason}`;
    const seen = reasonCounts.get(key) ?? { result: task.result as GroupResult, reason, tasks: 0 };
    reasonCounts.set(key, { ...seen, tasks: seen.tasks + 1 });
  }
  const sum = (list: readonly PageTask[]) => {
    const spent = list.map(spentOf);
    return {
      tasks: list.length,
      costUsd: input.costKnown ? spent.reduce((total, item) => total + item.costUsd, 0) : null,
      tokens: sumTokens(spent.map((item) => item.tokens)),
      timeMs: spent.reduce((total, item) => total + item.timeMs, 0),
    };
  };
  const failed = tasks.filter((task) => task.result === "not_completed" && reasonOf(task) !== null);
  const bumpy = tasks.filter(
    (task) => task.result === "completed_after_friction" && reasonOf(task) !== null,
  );
  // Friction is avoidable when any root cause of the task is one somebody can fix.
  const fixable = new Set(
    hits
      .filter(
        (hit) =>
          avoidabilityOf(hit.cause) !== "not_avoidable" && avoidabilityOf(hit.cause) !== "unknown",
      )
      .map((hit) => hit.task.taskId),
  );
  const friction = {
    ...sum(bumpy),
    extraTurns: bumpy.reduce((total, task) => total + (task.friction?.extraTurns ?? 0), 0),
    retriedCalls: bumpy.reduce((total, task) => total + (task.friction?.retriedCalls ?? 0), 0),
    inTurn: bumpy.filter((task) => (task.friction?.extraTurns ?? 0) === 0).length,
    avoidable: sum(bumpy.filter((task) => fixable.has(task.taskId))),
  };
  const reasons = [...reasonCounts.values()].sort(
    (a, b) =>
      (a.result === b.result ? 0 : a.result === "not_completed" ? -1 : 1) ||
      b.tasks - a.tasks ||
      a.reason.localeCompare(b.reason),
  );

  const dissatisfaction = paretoOf(
    answers.filter((answer) => !answer.satisfied),
    input.occurrences,
    taskOfTurn,
  );

  // Day by day over the window.
  const from = Date.parse(dayOf(new Date(input.now.getTime() - (input.windowDays - 1) * DAY_MS)));
  const days: string[] = [];
  for (let at = from; at <= input.now.getTime(); at += DAY_MS) days.push(dayOf(new Date(at)));
  const perDay = days.map((day) => {
    const said = answers.filter((answer) => answer.endedAt && dayOf(answer.endedAt) === day);
    return {
      day,
      answers: said.length,
      satisfied: said.filter((answer) => answer.satisfied).length,
    };
  });
  const daily = perDay.map((point, at): DayPoint => {
    const window = perDay.slice(Math.max(0, at - SMOOTHING_DAYS + 1), at + 1);
    const windowAnswers = window.reduce((sum, day) => sum + day.answers, 0);
    return {
      ...point,
      satisfaction: share(
        window.reduce((sum, day) => sum + day.satisfied, 0),
        windowAnswers,
      ),
      windowAnswers,
    };
  });

  return {
    tasks: tasks.length,
    completed,
    notCompleted: tasks.filter((task) => task.result === "not_completed").length,
    completion: share(completed, tasks.length),
    satisfaction: {
      score: scoreOf(answers),
      answers: answers.length,
      satisfied: answers.filter((answer) => answer.satisfied).length,
      inferred: answers.filter((answer) => answer.inferred).length,
    },
    statuses,
    groups,
    reasons,
    options,
    failure: sum(failed),
    friction,
    daily,
    dissatisfaction,
    costKnown: input.costKnown,
  };
}

/**
 * Each unsatisfied turn under one problem, its cause: the first thing that
 * went wrong in that turn (`occurrencesOf` order), else in another turn of its
 * task, else none named. A cause counts across every tool it happened on.
 * Problems most turns first; the vital few are the fewest whose shares reach
 * `PARETO_CUT`.
 */
function paretoOf(
  unsatisfied: readonly PageAnswer[],
  occurrences: readonly Pick<Occurrence, "turn" | "cause" | "tool">[],
  taskOfTurn: ReadonlyMap<string, PageTask>,
): Overview["dissatisfaction"] {
  const firstOf = new Map<string, Pick<Occurrence, "cause" | "tool">>();
  for (const occurrence of occurrences)
    if (!firstOf.has(occurrence.turn.turnId)) firstOf.set(occurrence.turn.turnId, occurrence);
  const counts = new Map<
    string,
    { cause: RootCause | null; tools: Map<string, number>; turns: number; answers: PageAnswer[] }
  >();
  for (const answer of unsatisfied) {
    const task = taskOfTurn.get(answer.turnId);
    const found =
      firstOf.get(answer.turnId) ??
      task?.turnIds.map((turnId) => firstOf.get(turnId)).find((hit) => hit !== undefined) ??
      null;
    // A turn that went wrong with every call working is as unexplained as one where nothing was found: one row.
    const cause = found && found.cause !== "no_failure" ? found.cause : null;
    const key = cause ?? "";
    const seen = counts.get(key) ?? {
      cause,
      tools: new Map<string, number>(),
      turns: 0,
      answers: [],
    };
    seen.turns += 1;
    seen.answers.push(answer);
    if (found?.tool) seen.tools.set(found.tool, (seen.tools.get(found.tool) ?? 0) + 1);
    counts.set(key, seen);
  }
  const total = unsatisfied.length;
  let running = 0;
  let vital = 0;
  const problems = [...counts]
    .sort(([keyA, a], [keyB, b]) => b.turns - a.turns || keyA.localeCompare(keyB))
    .map(([key, entry]): DissatisfactionProblem => {
      // A hair under the cut counts as reaching it: shares are fractions and add up with rounding.
      const reachedBefore = running >= PARETO_CUT - 1e-9;
      running += total === 0 ? 0 : entry.turns / total;
      if (!reachedBefore) vital += 1;
      const tools = [...entry.tools]
        .map(([tool, turns]) => ({ tool, turns }))
        .sort((a, b) => b.turns - a.turns || a.tool.localeCompare(b.tool));
      const examples = [...entry.answers]
        .sort(
          (a, b) =>
            (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0) ||
            a.turnId.localeCompare(b.turnId),
        )
        .slice(0, PARETO_EXAMPLES)
        .map((answer) => ({
          turnId: answer.turnId,
          endedAt: answer.endedAt?.toISOString() ?? null,
        }));
      return {
        key,
        cause: entry.cause,
        tools,
        turns: entry.turns,
        share: total === 0 ? 0 : entry.turns / total,
        cumulative: Math.min(1, running),
        vital: !reachedBefore,
        examples,
      };
    });
  const groups = DISSATISFACTION_GROUPS.map((group): DissatisfactionGroupTotal => {
    const turns = problems
      .filter((problem) => dissatisfactionGroupOf(problem.cause) === group)
      .reduce((sum, problem) => sum + problem.turns, 0);
    return { group, turns, share: total === 0 ? 0 : turns / total };
  });
  return { turns: total, problems, vital, groups };
}

/** The overview of a page with nothing read. */
export function emptyOverview(): Overview {
  return {
    tasks: 0,
    completed: 0,
    notCompleted: 0,
    completion: null,
    satisfaction: { score: null, answers: 0, satisfied: 0, inferred: 0 },
    statuses: TASK_FILTERS.map((filter) => ({
      filter,
      tasks: 0,
      share: 0,
      score: null,
      answers: 0,
    })),
    groups: [],
    reasons: [],
    options: { causes: [], tools: [] },
    failure: { tasks: 0, costUsd: null, tokens: null, timeMs: 0 },
    friction: {
      tasks: 0,
      extraTurns: 0,
      retriedCalls: 0,
      inTurn: 0,
      costUsd: null,
      tokens: null,
      timeMs: 0,
      avoidable: { tasks: 0, costUsd: null, tokens: null, timeMs: 0 },
    },
    daily: [],
    dissatisfaction: {
      turns: 0,
      problems: [],
      vital: 0,
      groups: DISSATISFACTION_GROUPS.map((group) => ({ group, turns: 0, share: 0 })),
    },
    costKnown: false,
  };
}
