import type {
  FrictionReason,
  SessionOutcome,
  TaskReason,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import { catalogEntryOf } from "@/lib/readings/trace-signals/self-corrections/issues";
import { catalogHref } from "@/lib/views/health/self-corrections/paths";
import type { ReasonGroup, ReasonRow, TaskExample } from "@/lib/views/traces/sentiment/overview";
import {
  CAUSE_LABEL,
  FRICTION_REASON_LABEL,
  FRICTION_REASON_MEANING,
  SESSION_OUTCOME_LABEL,
  TASK_FILTER_LABEL,
  TASK_REASON_LABEL,
  TASK_REASON_MEANING,
} from "@/lib/views/traces/sentiment/page-kinds";
import type {
  IntentScore,
  IntentScores,
  SentimentPageModel,
} from "@/lib/views/traces/sentiment/page-model";
import type { TaskFilter } from "@/lib/views/traces/sentiment/page-paths";
import {
  NO_SENTIMENT_FILTERS,
  type OutcomeSurface,
  type RootCauseHost,
  SENTIMENT_SORTS,
  type SentimentFilters,
  type SentimentSort,
  sentimentHref,
} from "@/lib/views/traces/sentiment/page-paths";

/**
 * The page model with every link built, so the client components take plain
 * data: where each status, reason, cause, tool and intent narrows the page
 * to, how each filter is removed, and each sort. Pure.
 */

/** A week by the Monday it starts on: "Aug 31". */
export function weekLabel(week: string): string {
  const date = new Date(`${week}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? week
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export interface FilterChipView {
  field: keyof SentimentFilters;
  label: string;
  value: string;
  removeHref: string;
}

export interface IntentScoreView extends IntentScore {
  /** The page narrowed to this intent. */
  href: string;
}

export interface IntentScoresView extends Omit<IntentScores, "satisfied" | "unsatisfied"> {
  satisfied: IntentScoreView[];
  unsatisfied: IntentScoreView[];
}

/** A task status with the page narrowed to it, or back out when it is the active one. */
export interface StatusView {
  filter: TaskFilter;
  label: string;
  tasks: number;
  share: number;
  score: number | null;
  answers: number;
  href: string;
  active: boolean;
}

/** A task to open in Traces: each of its turns, in order. */
export interface TaskExampleView extends TaskExample {
  turnHrefs: string[];
  /** The turn the cause happened in, in Traces. */
  traceHref: string;
}

export interface ReasonRowView extends Omit<ReasonRow, "examples"> {
  examples: TaskExampleView[];
  /** The page narrowed to this cause, and to this tool. */
  causeHref: string | null;
  toolHref: string | null;
  toolName: string | null;
  toolKind: "tool" | "skill";
  /** The tool in Catalog. */
  catalogHref: string | null;
}

export interface ReasonGroupView extends Omit<ReasonGroup, "rows"> {
  label: string;
  meaning: string;
  /** The page narrowed to this reason, or back out when it is the active one: every row it holds shows. */
  href: string;
  active: boolean;
  rows: ReasonRowView[];
}

/** A choice above the reasons table: a status (null for every reason) or one reason, with the tasks it holds. */
export interface ReasonChoiceView {
  key: string;
  /** For a reason, the result it explains. */
  result?: "not_completed" | "completed_after_friction";
  label: string;
  /** What it means, for a reason. */
  meaning: string | null;
  tasks: number;
  href: string;
  active: boolean;
}

/** A reason's words: why a task was not completed, or what got in the way before it was. */
export function reasonWords(reason: TaskReason | FrictionReason): {
  label: string;
  meaning: string;
} {
  return reason in FRICTION_REASON_LABEL
    ? {
        label: FRICTION_REASON_LABEL[reason as FrictionReason],
        meaning: FRICTION_REASON_MEANING[reason as FrictionReason],
      }
    : {
        label: TASK_REASON_LABEL[reason as TaskReason],
        meaning: TASK_REASON_MEANING[reason as TaskReason],
      };
}

/** One choice of the "Add filter" menu: the page with that filter on. */
export interface FilterOptionView {
  key: string;
  label: string;
  tasks: number;
  href: string;
}

export interface SentimentLinks {
  /** What can be added as a filter on Root cause analysis: a status, a reason, a cause or a tool. Ones already on are left out. */
  filterOptions: {
    statuses: FilterOptionView[];
    reasons: FilterOptionView[];
    causes: FilterOptionView[];
    tools: FilterOptionView[];
  };
  /** Each task status, with how satisfied people were in it. */
  statuses: StatusView[];
  /** Root causes by reason, in the order asked for. */
  reasonGroups: ReasonGroupView[];
  /** Every reason, not completed, or completed after friction: picking one narrows the reasons table to its result. */
  reasonStatuses: ReasonChoiceView[];
  /** Each reason of the picked result (of both, with none picked): picking one narrows the table to it. */
  reasonChoices: ReasonChoiceView[];
  filters: FilterChipView[];
  /** The intents people were most and least satisfied with; null when messages were not read. */
  intentScores: IntentScoresView | null;
  clearHref: string;
  sortHrefs: Record<SentimentSort, string>;
}

const FILTER_LABEL: Record<keyof SentimentFilters, string> = {
  intent: "Intent",
  cause: "Cause",
  tool: "Tool",
  week: "Week of",
  outcome: "Sessions that ended",
  task: "Status",
  reason: "Reason",
};

/** Every link of the page, on the surface it is shown on: its filters, sorts and pages stay on that page. */
export function sentimentLinks(
  model: SentimentPageModel,
  surface: OutcomeSurface = "sentiment",
  host?: RootCauseHost,
): SentimentLinks {
  const { projectId, windowDays: days, query } = model;
  const base = { days, sort: query.sort, surface, host };
  const here = (filters: Partial<SentimentFilters>) =>
    sentimentHref(projectId, { ...base, filters: { ...query.filters, ...filters } });

  const valueOf: Record<keyof SentimentFilters, (value: string) => string> = {
    intent: (value) => model.intentLabel ?? value,
    cause: (value) => CAUSE_LABEL[value as keyof typeof CAUSE_LABEL] ?? value,
    tool: (value) => catalogEntryOf(value).id,
    week: weekLabel,
    outcome: (value) => SESSION_OUTCOME_LABEL[value as SessionOutcome] ?? value,
    task: (value) => TASK_FILTER_LABEL[value as keyof typeof TASK_FILTER_LABEL] ?? value,
    reason: (value) =>
      value in FRICTION_REASON_LABEL || value in TASK_REASON_LABEL
        ? reasonWords(value as TaskReason | FrictionReason).label
        : value,
  };
  const filters = (Object.keys(FILTER_LABEL) as Array<keyof SentimentFilters>).flatMap(
    (field): FilterChipView[] => {
      const value = query.filters[field];
      return value
        ? [
            {
              field,
              label: FILTER_LABEL[field],
              value: valueOf[field](value),
              removeHref: here({ [field]: null }),
            },
          ]
        : [];
    },
  );

  const scored = (list: readonly IntentScore[]) =>
    list.map((entry) => ({ ...entry, href: here({ intent: entry.intent.id }) }));
  const intentScores = model.intentScores
    ? {
        ...model.intentScores,
        satisfied: scored(model.intentScores.satisfied),
        unsatisfied: scored(model.intentScores.unsatisfied),
      }
    : null;

  const statuses = model.overview.statuses.map((entry): StatusView => {
    const active = query.filters.task === entry.filter && query.filters.reason === null;
    return {
      ...entry,
      label: TASK_FILTER_LABEL[entry.filter],
      href: here({ task: active ? null : entry.filter, reason: null }),
      active,
    };
  });
  const reasonGroups = model.overview.groups.map((group): ReasonGroupView => {
    const active = query.filters.reason === group.reason;
    return {
      ...group,
      ...reasonWords(group.reason),
      href: here(
        active ? { task: null, reason: null } : { task: group.result, reason: group.reason },
      ),
      active,
      rows: group.rows.map((row) => {
        const entry = row.tool ? catalogEntryOf(row.tool) : null;
        return {
          ...row,
          causeHref: row.cause ? here({ cause: row.cause }) : null,
          toolHref: row.tool ? here({ tool: row.tool }) : null,
          toolName: entry?.id ?? null,
          toolKind: entry?.kind ?? "tool",
          catalogHref: row.tool ? catalogHref(projectId, row.tool) : null,
          examples: row.examples.map((example) => ({
            ...example,
            turnHrefs: example.turnIds.map(
              (turnId) =>
                `/project/${encodeURIComponent(projectId)}/traces/turns/${encodeURIComponent(turnId)}`,
            ),
            traceHref: `/project/${encodeURIComponent(projectId)}/traces/turns/${encodeURIComponent(example.turnId)}`,
          })),
        };
      }),
    };
  });

  const { task: pickedTask, reason: pickedReason } = query.filters;
  const pickedResult =
    pickedTask === "not_completed" || pickedTask === "completed_after_friction" ? pickedTask : null;
  const tasksOf = (result: string | null) =>
    model.overview.reasons
      .filter((entry) => result === null || entry.result === result)
      .reduce((sum, entry) => sum + entry.tasks, 0);
  const reasonStatuses: ReasonChoiceView[] = [
    {
      key: "all",
      label: "All reasons",
      meaning: null,
      tasks: tasksOf(null),
      href: here({ task: null, reason: null }),
      active: pickedResult === null,
    },
    ...(["not_completed", "completed_after_friction"] as const).map((result) => ({
      key: result,
      label: TASK_FILTER_LABEL[result],
      meaning: null,
      tasks: tasksOf(result),
      href: here({ task: result, reason: null }),
      active: pickedResult === result,
    })),
  ];
  const reasonChoices = model.overview.reasons
    .filter((entry) => pickedResult === null || entry.result === pickedResult)
    .map((entry): ReasonChoiceView => {
      const active = pickedReason === entry.reason && pickedTask === entry.result;
      return {
        key: `${entry.result}:${entry.reason}`,
        result: entry.result,
        ...reasonWords(entry.reason),
        tasks: entry.tasks,
        href: here(
          active
            ? { task: entry.result, reason: null }
            : { task: entry.result, reason: entry.reason },
        ),
        active,
      };
    });

  const filterOptions = {
    statuses: reasonStatuses
      .filter((status) => status.key !== "all" && !status.active && status.tasks > 0)
      .map((status) => ({
        key: status.key,
        label: status.label,
        tasks: status.tasks,
        href: status.href,
      })),
    reasons: reasonChoices
      .filter((reason) => !reason.active)
      .map((reason) => ({
        key: reason.key,
        label: reason.label,
        tasks: reason.tasks,
        href: reason.href,
      })),
    causes: model.overview.options.causes
      .filter((entry) => entry.cause !== query.filters.cause)
      .map((entry) => ({
        key: entry.cause,
        label: CAUSE_LABEL[entry.cause],
        tasks: entry.tasks,
        href: here({ cause: entry.cause }),
      })),
    tools: model.overview.options.tools
      .filter((entry) => entry.tool !== query.filters.tool)
      .map((entry) => ({
        key: entry.tool,
        label: catalogEntryOf(entry.tool).id,
        tasks: entry.tasks,
        href: here({ tool: entry.tool }),
      })),
  };

  return {
    filterOptions,
    statuses,
    reasonGroups,
    reasonStatuses,
    reasonChoices,
    intentScores,
    filters,
    clearHref: sentimentHref(projectId, { ...base, filters: NO_SENTIMENT_FILTERS }),
    sortHrefs: Object.fromEntries(
      SENTIMENT_SORTS.map((sort) => [
        sort,
        sentimentHref(projectId, { ...base, filters: query.filters, sort }),
      ]),
    ) as Record<SentimentSort, string>,
  };
}
