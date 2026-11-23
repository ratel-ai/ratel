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
import {
  type Cut,
  type CutValue,
  type IntentScore,
  type IntentScores,
  NO_INTENT,
  OTHER_INTENTS,
  type PageGroup,
  type RootCauseRow,
  type SentimentPageModel,
  versionLabel,
} from "@/lib/views/traces/sentiment/page-model";
import type { TaskFilter } from "@/lib/views/traces/sentiment/page-paths";
import {
  NO_SENTIMENT_FILTERS,
  type OutcomeSurface,
  SENTIMENT_SORTS,
  type SentimentFilters,
  type SentimentSort,
  sentimentHref,
} from "@/lib/views/traces/sentiment/page-paths";

/**
 * The page model with every link built, so the client components take plain
 * data: where a row's intent, cause and tool filter to, where a cut's value
 * goes, how each filter is removed, and the pages either side. A new filter,
 * sort or thin switch starts again on the first page. Pure.
 */

/** A week by the Monday it starts on: "Aug 31". */
export function weekLabel(week: string): string {
  const date = new Date(`${week}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? week
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export interface RowView extends RootCauseRow {
  /** The page narrowed to this row's intent, cause or tool. A folded row ("Other intents") has no one intent to narrow to. */
  intentHref: string | null;
  causeHref: string;
  toolHref: string | null;
  /** The tool in Catalog. */
  catalogHref: string | null;
  toolName: string | null;
  toolKind: "tool" | "skill";
  /** Each example's turn on Traces. */
  exampleHrefs: string[];
}

export interface FilterChipView {
  field: keyof SentimentFilters;
  label: string;
  value: string;
  removeHref: string;
}

export interface CutValueView extends CutValue {
  /** The page narrowed to this value, or without the filter when it is the active one. */
  href: string;
}

export interface CutView {
  values: CutValueView[];
  more: number;
}

export interface GroupView extends Omit<PageGroup, "rows"> {
  rows: RowView[];
  /** The page narrowed to this cause. */
  causeHref: string;
}

/** One way sessions ended, as a choice above the root causes; `outcome` null is every session. */
export interface EndedView {
  outcome: SessionOutcome | null;
  label: string;
  sessions: number;
  href: string;
  active: boolean;
}

export interface IntentScoreView extends IntentScore {
  /** The page narrowed to this intent. */
  href: string;
}

export interface IntentScoresView extends Omit<IntentScores, "satisfied" | "unsatisfied"> {
  satisfied: IntentScoreView[];
  unsatisfied: IntentScoreView[];
}

/** One task result or reason with the page narrowed to it, or back out when it is the active one. */
export interface TaskChoiceView {
  key: string;
  label: string;
  tasks: number;
  share: number;
  href: string;
  active: boolean;
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
  /** This page's rows, in the order listed. */
  rows: RowView[];
  groups: GroupView[];
  /** The previous and next page; null at either end. */
  prevHref: string | null;
  nextHref: string | null;
  filters: FilterChipView[];
  /** Every session, then each way a session can end: picking one narrows the root causes to its sessions. */
  ended: EndedView[];
  /** Each task result, and each reason a task was not completed: picking one narrows the root causes to those tasks. */
  taskClasses: TaskChoiceView[];
  taskReasons: TaskChoiceView[];
  /** The intents people were most and least satisfied with; null when messages were not read. */
  intentScores: IntentScoresView | null;
  clearHref: string;
  /** The page with thin rows shown, or hidden again. */
  thinHref: string;
  sortHrefs: Record<SentimentSort, string>;
  cuts: { intent: CutView; tool: CutView; week: CutView; version: CutView };
}

const FILTER_LABEL: Record<keyof SentimentFilters, string> = {
  intent: "Intent",
  cause: "Cause",
  tool: "Tool",
  week: "Week of",
  version: "Catalog version",
  outcome: "Sessions that ended",
  task: "Status",
  reason: "Reason",
};

/** Every link of the page, on the surface it is shown on: its filters, sorts and pages stay on that page. */
export function sentimentLinks(
  model: SentimentPageModel,
  surface: OutcomeSurface = "sentiment",
): SentimentLinks {
  const { projectId, windowDays: days, query } = model;
  const base = { days, sort: query.sort, thin: query.thin, surface };
  const here = (filters: Partial<SentimentFilters>) =>
    sentimentHref(projectId, { ...base, filters: { ...query.filters, ...filters } });

  const view = (row: RootCauseRow): RowView => {
    const entry = row.tool ? catalogEntryOf(row.tool) : null;
    return {
      ...row,
      intentHref:
        row.intent?.id === OTHER_INTENTS.id ? null : here({ intent: row.intent?.id ?? NO_INTENT }),
      causeHref: here({ cause: row.cause }),
      toolHref: row.tool ? here({ tool: row.tool }) : null,
      catalogHref: row.tool ? catalogHref(projectId, row.tool) : null,
      toolName: entry?.id ?? null,
      toolKind: entry?.kind ?? "tool",
      exampleHrefs: row.examples.map(
        (example) =>
          `/project/${encodeURIComponent(projectId)}/traces/turns/${encodeURIComponent(example.turnId)}`,
      ),
    };
  };
  const rows = model.rows.map(view);
  const groups = model.groups.map(
    (group): GroupView => ({
      ...group,
      rows: group.rows.map(view),
      causeHref: here({ cause: group.cause }),
    }),
  );
  const { page, pages } = model.pagination;
  const pageHref = (to: number) =>
    sentimentHref(projectId, { ...base, filters: query.filters, page: to });

  const valueOf: Record<keyof SentimentFilters, (value: string) => string> = {
    intent: (value) =>
      model.cuts.intent.values.find((v) => v.key === value)?.label ??
      (value === NO_INTENT ? "No intent" : value),
    cause: (value) => CAUSE_LABEL[value as keyof typeof CAUSE_LABEL] ?? value,
    tool: (value) => catalogEntryOf(value).id,
    week: weekLabel,
    version: versionLabel,
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

  const cut = (field: "intent" | "tool" | "week" | "version", source: Cut): CutView => ({
    more: source.more,
    values: source.values.map((value) => ({
      ...value,
      href: here({ [field]: value.active ? null : value.key }),
    })),
  });

  const ended: EndedView[] = [
    {
      outcome: null,
      label: "All sessions",
      sessions: model.split.total,
      href: here({ outcome: null }),
      active: query.filters.outcome === null,
    },
    ...model.split.classes.map((entry) => ({
      outcome: entry.outcome,
      label: SESSION_OUTCOME_LABEL[entry.outcome],
      sessions: entry.sessions,
      href: here({ outcome: entry.outcome }),
      active: query.filters.outcome === entry.outcome,
    })),
  ];

  const scored = (list: readonly IntentScore[]) =>
    list.map((entry) => ({ ...entry, href: here({ intent: entry.intent.id }) }));
  const intentScores = model.intentScores
    ? {
        ...model.intentScores,
        satisfied: scored(model.intentScores.satisfied),
        unsatisfied: scored(model.intentScores.unsatisfied),
      }
    : null;

  const taskClasses = model.tasks.classes.map((entry): TaskChoiceView => {
    const active = query.filters.task === entry.filter && query.filters.reason === null;
    return {
      key: entry.filter,
      label: TASK_FILTER_LABEL[entry.filter],
      tasks: entry.tasks,
      share: entry.share,
      href: here({ task: active ? null : (entry.filter as TaskFilter), reason: null }),
      active,
    };
  });
  const taskReasons = model.tasks.reasons.map((entry): TaskChoiceView => {
    const active = query.filters.reason === entry.reason;
    return {
      key: entry.reason,
      label: TASK_REASON_LABEL[entry.reason],
      tasks: entry.tasks,
      share: entry.share,
      href: here(
        active ? { task: null, reason: null } : { task: "not_completed", reason: entry.reason },
      ),
      active,
    };
  });

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
    rows,
    groups,
    ended,
    taskClasses,
    taskReasons,
    intentScores,
    prevHref: page > 1 ? pageHref(page - 1) : null,
    nextHref: page < pages ? pageHref(page + 1) : null,
    filters,
    clearHref: sentimentHref(projectId, { ...base, filters: NO_SENTIMENT_FILTERS }),
    thinHref: sentimentHref(projectId, { ...base, filters: query.filters, thin: !query.thin }),
    sortHrefs: Object.fromEntries(
      SENTIMENT_SORTS.map((sort) => [
        sort,
        sentimentHref(projectId, { ...base, filters: query.filters, sort }),
      ]),
    ) as Record<SentimentSort, string>,
    cuts: {
      intent: cut("intent", model.cuts.intent),
      tool: cut("tool", model.cuts.tool),
      week: cut("week", model.cuts.week),
      version: cut("version", model.cuts.version),
    },
  };
}
