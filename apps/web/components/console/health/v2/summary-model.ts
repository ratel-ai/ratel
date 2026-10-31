import type { FixLookup, TaskLookup } from "@/components/console/health/v2/issue-rows";
import {
  type HealthPageModel,
  type SourceMode,
  type WorkflowsView,
  windowPhrase,
} from "@/lib/readings/trace-signals/view";
import type { FixesModel } from "@/lib/views/fixes/types";
import type { HealthPageState } from "@/lib/views/health/page-state";
import type { TaskListModel, TaskRow } from "@/lib/views/tasks/model";
import { TASK_STATUS_RANK } from "@/lib/views/tasks/status";

/**
 * The Summary's small decisions, pure: its one line under the title, the
 * state it is in when the route could not decide one, which tasks need a
 * look, and the task and fix lookups the issue rows read.
 */

export const SUMMARY_TITLE = "Agent health";

const SOURCE: Readonly<Record<SourceMode, string>> = {
  sdk: "the Ratel SDK",
  otel: "OpenTelemetry",
  mixed: "the Ratel SDK and OpenTelemetry",
};

/** The lane a reading came from, in words: "OpenTelemetry", "the Ratel SDK". */
export function sourceWords(mode: SourceMode): string {
  return SOURCE[mode];
}

/** "What Site Copilot gets wrong this week, from 1,436 turns through OpenTelemetry." */
export function summaryDescription(input: {
  projectName: string;
  windowDays: number;
  turns: number;
  sourceMode: SourceMode;
  reading: boolean;
}): string {
  const what = `What ${input.projectName} gets wrong ${windowPhrase(input.windowDays)}`;
  if (!input.reading || input.turns <= 0) return `${what}, read from its own traces.`;
  const turns = `${input.turns.toLocaleString("en-US")} ${input.turns === 1 ? "turn" : "turns"}`;
  return `${what}, from ${turns} through ${SOURCE[input.sourceMode]}.`;
}

/**
 * The page's state: the route's when it decided one; otherwise (a ledger
 * that did not load) what the model alone can say, as the page always has.
 */
export function summaryState(
  decided: HealthPageState | null,
  model: Pick<HealthPageModel, "turns" | "floor" | "waitingOn">,
): HealthPageState {
  if (decided) return decided;
  if (model.turns >= model.floor && model.turns > 0) return { kind: "ready" };
  if (model.turns > 0)
    return {
      kind: "too_few",
      turns: model.turns,
      floor: model.floor,
      imported: false,
      wider: null,
    };
  if (model.waitingOn === "tool_spans") return { kind: "tool_spans" };
  return { kind: "nothing_yet" };
}

/** Tasks shown in "Tasks that need a look". */
export const TASKS_SHOWN = 5;

/** The tasks that are failing, slow or worth watching: worst status first, then the busiest. */
export function tasksNeedingLook(rows: readonly TaskRow[], limit = TASKS_SHOWN): TaskRow[] {
  return rows
    .filter((row) => row.status !== "healthy")
    .sort(
      (a, b) =>
        TASK_STATUS_RANK[a.status] - TASK_STATUS_RANK[b.status] ||
        b.runs - a.runs ||
        (a.id < b.id ? -1 : 1),
    )
    .slice(0, limit);
}

/**
 * Each task with its steps, for naming the task an issue is about: names
 * and colors from the task list (the ones every page shows), steps from the
 * reading. Without the list, the reading's own names and no color.
 */
export function taskLookups(
  tasks: TaskListModel | null,
  workflows: Pick<WorkflowsView, "items"> | null,
): TaskLookup[] {
  const items = workflows?.items ?? [];
  const rows = new Map((tasks?.rows ?? []).map((row) => [row.id, row]));
  return items.map((item) => {
    const row = rows.get(item.id);
    return {
      id: item.id,
      name: row?.name ?? item.name,
      color: row?.color ?? null,
      tools: item.focusTools,
      runs: row?.runs ?? item.runs,
    };
  });
}

/**
 * Open and applied fixes, as the rows look them up: what each changes and
 * which tools, so a description update links to Quality › Descriptions.
 * Null when Fixes could not be read.
 */
export function fixLookups(fixes: Pick<FixesModel, "open" | "applied"> | null): FixLookup[] | null {
  if (!fixes) return null;
  return [...fixes.open, ...fixes.applied].map((fix) => ({
    id: fix.id,
    aliases: fix.aliases,
    title: fix.title,
    status: fix.status,
    kind: fix.kind,
    source: fix.source,
    toolIds: (fix.subject?.tools ?? []).map((tool) => tool.id),
  }));
}
