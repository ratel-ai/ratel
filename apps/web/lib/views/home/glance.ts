import type { TaskColorSlot } from "@ratel/design-system/task-colors";
import { projectRoot } from "@/lib/console/navigation";
import { fixHref } from "@/lib/views/fixes/href";
import type { FixesModel } from "@/lib/views/fixes/types";
import type { SelfCorrectionsCardModel } from "@/lib/views/health/self-corrections/card";
import { mostlyUnanswered } from "@/lib/views/intents/topics-view";
import type { TaskListModel } from "@/lib/views/tasks/model";
import { taskHref, tasksHref, topicHref } from "@/lib/views/tasks/paths";

/**
 * The one product at a glance (DESIGN.md, The product's nouns): what people
 * want (Intents), what the agent does for it (Tasks), where it goes back on
 * itself (Self-corrections) and what to change (Fixes). One tile each: one
 * number, one line, a pin. Each tile reads its numbers the way its own page
 * does, so the Overview and the page never disagree. Pure.
 *
 * PRIVACY: intent and task names are written from people's asks. They are
 * text only; links and keys carry ids.
 */

/** A read that failed, as opposed to one that found nothing yet (null). */
export const READ_FAILED = "failed" as const;
export type GlanceRead<T> = T | null | typeof READ_FAILED;

/* - Intents ------------------------------------------------------------------- */

/** What the Overview reads of the latest intents reading: counts per intent, and the names. */
export interface IntentsRead {
  topics: readonly { id: string; turns: number; answered: number }[];
  /** Stored names by intent id; an intent without one is not listed (as on Intents). */
  names: ReadonlyMap<string, string>;
}

export interface IntentRef {
  id: string;
  name: string;
  /** The intent open in its panel on Intents. */
  href: string;
}

export interface UnansweredIntent extends IntentRef {
  turns: number;
  unanswered: number;
  answeredShare: number;
}

export interface IntentsGlance {
  state: "ready" | "none" | "failed";
  href: string;
  count: number;
  /** The intent with the most asks. */
  top: IntentRef | null;
  /** Intents most of whose asks went unanswered (as Intents marks them), most unanswered first. */
  unanswered: UnansweredIntent[];
}

export function intentsGlance(projectId: string, read: GlanceRead<IntentsRead>): IntentsGlance {
  const href = `${projectRoot(projectId)}/intents`;
  if (read === READ_FAILED) return { state: "failed", href, count: 0, top: null, unanswered: [] };
  if (read === null) return { state: "none", href, count: 0, top: null, unanswered: [] };
  const named = read.topics.flatMap((topic) => {
    const name = read.names.get(topic.id);
    return name === undefined ? [] : [{ ...topic, name, href: topicHref(projectId, topic.id) }];
  });
  const busiest = [...named].sort((a, b) => b.turns - a.turns || a.name.localeCompare(b.name))[0];
  const unanswered = named
    .filter((topic) => mostlyUnanswered(topic.turns - topic.answered, topic.turns))
    .map((topic) => ({
      id: topic.id,
      name: topic.name,
      href: topic.href,
      turns: topic.turns,
      unanswered: topic.turns - topic.answered,
      answeredShare: topic.turns > 0 ? topic.answered / topic.turns : 0,
    }))
    .sort((a, b) => b.unanswered - a.unanswered || a.name.localeCompare(b.name));
  return {
    state: "ready",
    href,
    count: named.length,
    top:
      busiest && busiest.turns > 0
        ? { id: busiest.id, name: busiest.name, href: busiest.href }
        : null,
    unanswered,
  };
}

/* - Tasks --------------------------------------------------------------------- */

/** Fewest runs before a task's finish rate can make it the weakest. */
export const WEAKEST_MIN_RUNS = 5;

export interface TaskRef {
  id: string;
  name: string;
  /** Its color, when it is one of the busiest three; neutral otherwise. */
  slot: TaskColorSlot | null;
  href: string;
}

export interface TasksGlance {
  state: "ready" | "none" | "blocked" | "failed";
  /** Why no task can be read yet, when blocked. */
  blocked: TaskListModel["blocked"];
  href: string;
  count: number;
  /** Of the runs that asked for a task, those that ended without a failed call (as on Tasks). */
  finishRate: number | null;
  /** The task that finishes least, when one falls short. */
  weakest: (TaskRef & { finishRate: number }) | null;
  /** Every task by id, for naming the task an issue is raised on. */
  byId: Readonly<Record<string, TaskRef>>;
  /** Each task's own steps (its core tools). */
  steps: readonly (readonly string[])[];
}

/** What the Overview reads of Tasks: the list as Tasks builds it, and each task's own steps. */
export interface TasksRead {
  list: TaskListModel;
  steps: readonly (readonly string[])[];
}

export function tasksGlance(projectId: string, read: GlanceRead<TasksRead>): TasksGlance {
  const href = tasksHref(projectId);
  const empty = {
    blocked: null,
    href,
    count: 0,
    finishRate: null,
    weakest: null,
    byId: {},
    steps: [],
  };
  if (read === READ_FAILED) return { ...empty, state: "failed" };
  const list = read?.list;
  if (!list || list.state === "no_reading") return { ...empty, state: "none" };
  if (list.state === "blocked") return { ...empty, state: "blocked", blocked: list.blocked };
  const refs = list.rows.map((row) => ({
    id: row.id,
    name: row.name,
    slot: row.color,
    href: taskHref(projectId, row.id),
    finishRate: row.finishRate,
    runs: row.runs,
  }));
  const weakest = refs
    .filter(
      (row): row is typeof row & { finishRate: number } =>
        row.finishRate !== null && row.finishRate < 1 && row.runs >= WEAKEST_MIN_RUNS,
    )
    .sort((a, b) => a.finishRate - b.finishRate || b.runs - a.runs || (a.id < b.id ? -1 : 1))[0];
  return {
    ...empty,
    state: "ready",
    count: list.rows.length,
    finishRate: list.stats.finishRate,
    weakest: weakest
      ? {
          id: weakest.id,
          name: weakest.name,
          slot: weakest.slot,
          href: weakest.href,
          finishRate: weakest.finishRate,
        }
      : null,
    byId: Object.fromEntries(
      refs.map(({ id, name, slot, href: taskPage }) => [id, { id, name, slot, href: taskPage }]),
    ),
    steps: read?.steps ?? [],
  };
}

/* - Self-corrections ------------------------------------------------------------ */

export interface SelfCorrectionsGlance {
  state: SelfCorrectionsCardModel["state"];
  href: string;
  windowDays: number;
  /** Per 100 turns, formatted ("18.4"). */
  value: string;
  delta: SelfCorrectionsCardModel["rate"]["delta"];
  events: number;
  /** The tool the agent corrects itself after most. */
  topTool: string | null;
}

/** Agent health's Self-corrections card, read as a tile. */
export function selfCorrectionsGlance(card: SelfCorrectionsCardModel): SelfCorrectionsGlance {
  return {
    state: card.state,
    href: card.href,
    windowDays: card.windowDays,
    value: card.rate.value,
    delta: card.state === "ready" ? card.rate.delta : undefined,
    events: card.events,
    topTool: card.state === "ready" && card.events > 0 ? (card.topTool?.name ?? null) : null,
  };
}

/* - Fixes --------------------------------------------------------------------- */

/**
 * Quality › Descriptions, the description-update page: the list, one tool's
 * description (`?tool=`), or one drafted rewrite open (`?peek=rewrite:<id>`).
 */
export function descriptionsHref(
  projectId: string,
  opts: { tool?: string | null; peek?: string | null } = {},
): string {
  const params = new URLSearchParams();
  if (opts.tool) params.set("tool", opts.tool);
  if (opts.peek) params.set("peek", opts.peek);
  const query = params.toString();
  return `${projectRoot(projectId)}/quality/descriptions${query ? `?${query}` : ""}`;
}

/** What the Overview reads of Fixes. */
export type FixesSlice = Pick<FixesModel, "open" | "applied" | "rewritesOn">;

export interface FixesGlance {
  state: "ready" | "failed";
  href: string;
  /** Open fixes: changes ready to make. */
  open: number;
  /** Of those, description updates Cloud can apply now: the count Needs attention shows (`applicableDescriptions`). */
  descriptions: number;
  /** Where description updates are made: Quality › Descriptions (every other fix is on Fixes). */
  descriptionsPageHref: string;
}

/** Description updates Cloud can apply now, plan included; the Fixes tile and Needs attention both show this. */
export function applicableDescriptions(fixes: FixesSlice): number {
  return fixes.rewritesOn ? fixes.open.filter((fix) => fix.actions.apply).length : 0;
}

export function fixesGlance(projectId: string, fixes: FixesSlice | null): FixesGlance {
  const href = fixHref(projectId);
  const descriptionsPageHref = descriptionsHref(projectId);
  if (!fixes) return { state: "failed", href, open: 0, descriptions: 0, descriptionsPageHref };
  return {
    state: "ready",
    href,
    open: fixes.open.length,
    descriptions: applicableDescriptions(fixes),
    descriptionsPageHref,
  };
}

/* - All four ------------------------------------------------------------------ */

export interface Glance {
  intents: IntentsGlance;
  tasks: TasksGlance;
  selfCorrections: SelfCorrectionsGlance;
  fixes: FixesGlance;
}
