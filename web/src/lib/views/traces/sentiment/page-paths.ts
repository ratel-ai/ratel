import {
  FRICTION_REASONS,
  type FrictionReason,
  SESSION_OUTCOMES,
  type SessionOutcome,
  TASK_REASONS,
  type TaskReason,
} from "@/lib/readings/trace-signals/outcomes/kinds";
import { WINDOW_DAY_OPTIONS, type WindowDays } from "@/lib/readings/trace-signals/view";
import { ROOT_CAUSES, type RootCause } from "@/lib/views/traces/sentiment/page-kinds";
import { CALL_PEEK, TURN_PEEK } from "@/lib/views/traces/turn-peek";

/**
 * The Sentiment analysis page's address: its window, its four cuts, the
 * cause and how sessions ended as filters, the sort, whether thin rows show, the page of root causes
 * and the row that is open. Everything the page shows is in the URL, so a
 * link reproduces it.
 */

/** Weekly trends need several weeks, so the page opens on a month, not Agent health's week. */
export const SENTIMENT_DEFAULT_WINDOW_DAYS: WindowDays = 30;

/**
 * How root causes are ordered: sessions left unresolved, sessions, the share
 * unresolved, the model cost of their turns, the time their turns took, and
 * the newest first.
 */
export const SENTIMENT_SORTS = ["impact", "sessions", "share", "cost", "time", "recent"] as const;

export type SentimentSort = (typeof SENTIMENT_SORTS)[number];

export const SENTIMENT_DEFAULT_SORT: SentimentSort = "impact";

export interface SentimentFilters {
  /** An intent id (`intent_clusters.id`), or `none` for turns the engine placed nowhere. */
  intent: string | null;
  cause: RootCause | null;
  /** A node id: a tool's catalog id, or `skill:<id>`. */
  tool: string | null;
  /** The Monday a week starts on, `YYYY-MM-DD` (UTC). */
  week: string | null;
  /** A catalog version as the SDK sent it. */
  version: string | null;
  /** How the session ended: root causes of sessions that ended this way only. */
  outcome: SessionOutcome | null;
  /** What the task came to: root causes of tasks with this result only (`TASK_FILTERS`). */
  task: TaskFilter | null;
  /** Why the task was not completed, or what got in the way before it was: root causes of tasks with this reason only. */
  reason: TaskReason | FrictionReason | null;
}

/**
 * A task status as the page shows it and filters by it. A completed task
 * whose goal nothing read counts as completed; a task whose result can't be
 * told is left off the page.
 */
export const TASK_FILTERS = ["completed", "completed_after_friction", "not_completed"] as const;

export type TaskFilter = (typeof TASK_FILTERS)[number];

/** A task's status on the page; null for a task whose result can't be told, which the page leaves out. */
export function taskFilterOf(task: { result: string }): TaskFilter | null {
  return TASK_FILTERS.find((known) => known === task.result) ?? null;
}

export const NO_SENTIMENT_FILTERS: SentimentFilters = {
  intent: null,
  cause: null,
  tool: null,
  week: null,
  version: null,
  outcome: null,
  task: null,
  reason: null,
};

export interface SentimentQuery {
  filters: SentimentFilters;
  sort: SentimentSort;
  /** Rows under the minimum count show too. */
  thin: boolean;
  /** The page of root causes, from 1. */
  page: number;
  /** The open row's key (`RootCauseRow.key`). */
  open: string | null;
}

export const DEFAULT_SENTIMENT_QUERY: SentimentQuery = {
  filters: NO_SENTIMENT_FILTERS,
  sort: SENTIMENT_DEFAULT_SORT,
  thin: false,
  page: 1,
  open: null,
};

/** Pages asked for past this read as the first: no window holds that many root causes. */
const MAX_PAGE = 10_000;

type Search = Readonly<Record<string, string | readonly string[] | undefined>>;

const MAX_VALUE_CHARS = 200;
const WEEK = /^\d{4}-\d{2}-\d{2}$/;

function first(
  value: string | readonly string[] | undefined,
  max = MAX_VALUE_CHARS,
): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** What a page URL asks for; anything unknown reads as not asked. */
export function parseSentimentQuery(search: Search): SentimentQuery {
  const cause = first(search.cause);
  const ended = first(search.ended);
  const task = first(search.task);
  const why = first(search.why);
  const week = first(search.week);
  const sort = first(search.sort);
  const page = first(search.page);
  const pageNumber = page && /^\d+$/.test(page) ? Number(page) : 1;
  return {
    filters: {
      intent: first(search.intent),
      cause: ROOT_CAUSES.find((known) => known === cause) ?? null,
      tool: first(search.tool),
      week: week && WEEK.test(week) ? week : null,
      version: first(search.version),
      outcome: SESSION_OUTCOMES.find((known) => known === ended) ?? null,
      task: TASK_FILTERS.find((known) => known === task) ?? null,
      reason: [...TASK_REASONS, ...FRICTION_REASONS].find((known) => known === why) ?? null,
    },
    sort: SENTIMENT_SORTS.find((known) => known === sort) ?? SENTIMENT_DEFAULT_SORT,
    thin: first(search.thin) === "1",
    page: pageNumber >= 1 && pageNumber <= MAX_PAGE ? pageNumber : 1,
    open: first(search.open, 600),
  };
}

/** The window a page URL asks for: one of Agent health's, a month by default, within the plan's. */
export function parseSentimentWindow(
  raw: string | readonly string[] | undefined,
  maxDays: number,
): WindowDays {
  const value = first(raw);
  const parsed = value && /^\d+$/.test(value) ? Number(value) : NaN;
  const requested =
    WINDOW_DAY_OPTIONS.find((days) => days === parsed) ?? SENTIMENT_DEFAULT_WINDOW_DAYS;
  if (requested <= maxDays) return requested;
  return WINDOW_DAY_OPTIONS.filter((days) => days <= maxDays).at(-1) ?? WINDOW_DAY_OPTIONS[0];
}

export function hasSentimentFilters(filters: SentimentFilters): boolean {
  return Object.values(filters).some((value) => value !== null);
}

/** The page on a window, filters, sort, page and open row; every default is left out, so the bare path is the default page. */
/**
 * The two surfaces that read the same outcome rows: Sentiment analysis (a page
 * under Traces: how people took it) and Root cause analysis (a panel: why
 * tasks were not completed, or completed only after friction). The panel
 * opens over a host page, Agent health by default, and keeps its state in the
 * host's address under its own prefix, so neither reads the other's filters.
 */
export type OutcomeSurface = "sentiment" | "root-causes";

/** The page the panel opens over: its path and its own query. */
export interface RootCauseHost {
  path: string;
  query: string;
}

/** The parameter that says the panel is open, and the prefix of its state. */
export const ROOT_CAUSES_PARAM = "rc";
const ROOT_CAUSES_PREFIX = "rc_";
/** The parameter that holds the root cause open in the panel. */
export const ROOT_CAUSE_PEEK = `${ROOT_CAUSES_PREFIX}open`;

/** A host page's query without the panel and the turn open in it. */
export function withoutRootCauses(search: string): string {
  const query = new URLSearchParams(search);
  for (const key of [...query.keys()])
    if (
      key === ROOT_CAUSES_PARAM ||
      key.startsWith(ROOT_CAUSES_PREFIX) ||
      key === TURN_PEEK ||
      key === CALL_PEEK
    )
      query.delete(key);
  return query.toString();
}

/** The state of the panel a page URL opens; null when it opens none. */
export function parseRootCauseQuery(search: Search): SentimentQuery | null {
  if (first(search[ROOT_CAUSES_PARAM]) !== "1") return null;
  return parseSentimentQuery(
    Object.fromEntries(
      Object.entries(search).flatMap(([key, value]) =>
        key.startsWith(ROOT_CAUSES_PREFIX) ? [[key.slice(ROOT_CAUSES_PREFIX.length), value]] : [],
      ),
    ),
  );
}

export function sentimentHref(
  projectId: string,
  options: {
    days?: WindowDays;
    filters?: Partial<SentimentFilters>;
    sort?: SentimentSort;
    thin?: boolean;
    page?: number;
    open?: string | null;
    surface?: OutcomeSurface;
    /** Where the root causes panel opens; Agent health when absent. */
    host?: RootCauseHost;
  } = {},
): string {
  const filters = { ...NO_SENTIMENT_FILTERS, ...options.filters };
  const panel = options.surface === "root-causes";
  const query = new URLSearchParams(panel ? withoutRootCauses(options.host?.query ?? "") : "");
  const set = (key: string, value: string | null | undefined) => {
    if (value) query.set(panel ? `${ROOT_CAUSES_PREFIX}${key}` : key, value);
  };
  if (panel) {
    // The panel reads its host's window. Agent health opens on another default, so it is always named.
    if (!options.host && options.days) query.set("days", String(options.days));
    query.set(ROOT_CAUSES_PARAM, "1");
  } else if (options.days && options.days !== SENTIMENT_DEFAULT_WINDOW_DAYS) {
    query.set("days", String(options.days));
  }
  set("intent", filters.intent);
  set("cause", filters.cause);
  set("tool", filters.tool);
  set("week", filters.week);
  set("version", filters.version);
  set("ended", filters.outcome);
  set("task", filters.task);
  set("why", filters.reason);
  set("sort", options.sort && options.sort !== SENTIMENT_DEFAULT_SORT ? options.sort : null);
  set("thin", options.thin ? "1" : null);
  set("page", options.page && options.page > 1 ? String(options.page) : null);
  set("open", options.open);
  const text = query.toString();
  const root = `/project/${encodeURIComponent(projectId)}`;
  const path = panel ? (options.host?.path ?? `${root}/health`) : `${root}/traces/sentiment`;
  return text ? `${path}?${text}` : path;
}

/** Root cause analysis, narrowed as asked. */
export function rootCausesHref(
  projectId: string,
  options: Omit<Parameters<typeof sentimentHref>[1] & object, "surface"> = {},
): string {
  return sentimentHref(projectId, { ...options, surface: "root-causes" });
}
