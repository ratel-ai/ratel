import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseProjectUuid } from "@/lib/console/scope/cookie";
import { hasNoNul, NUL_PROBLEM } from "@/lib/contracts/json-text";
import type { SessionUser } from "@/lib/contracts/session";
import { importDashboard } from "@/lib/views/dashboards/document";
import { defaultsSchema, filtersProblem, filtersRefusal } from "@/lib/views/dashboards/filters";
import {
  compacted,
  defaultSize,
  freePosition,
  gridPositionSchema,
} from "@/lib/views/dashboards/layout";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import { STARTER_NAME, STARTER_WIDGETS } from "@/lib/views/dashboards/starter";
import type * as store from "@/lib/views/dashboards/store";
import { isWidget } from "@/lib/views/dashboards/stored-widget";
import {
  type DashboardDefaults,
  type DashboardEditor,
  type DashboardFilters,
  type DashboardWidget,
  type GridPosition,
  MAX_DASHBOARD_NAME,
  MAX_DASHBOARDS,
  MAX_WIDGETS,
  type ScorerOption,
  type Widget,
  type WidgetInput,
} from "@/lib/views/dashboards/types";

export type DashboardActionInput = { projectId: string } & (
  | { action: "create"; name: string }
  | { action: "create-starter" }
  /** A document that an export or an agent wrote. */
  | { action: "import"; document: unknown }
  | { action: "rename"; dashboardId: string; name: string }
  | { action: "delete"; dashboardId: string }
  /** What the dashboard opens with from now on. */
  | { action: "save-defaults"; dashboardId: string; defaults: DashboardDefaults }
  /** At the first free place, or back where it was (`layout`, the undo of a removal). */
  | {
      action: "add-widget";
      dashboardId: string;
      widget: WidgetInput;
      layout?: GridPosition;
      missingScorer?: string;
    }
  | { action: "edit-widget"; dashboardId: string; widgetId: string; widget: WidgetInput }
  /** Where a drag, a resize or a step left the widgets. */
  | { action: "save-layout"; dashboardId: string; layouts: Record<string, GridPosition> }
  | { action: "remove-widget"; dashboardId: string; widgetId: string }
);

export type DashboardActionResult =
  | {
      ok: true;
      dashboardId: string;
      /** An import: the names of the scorers the project does not have. */
      missingScorers?: string[];
    }
  | { ok: false; error: string };

export interface DashboardActionDeps {
  getSession(): Promise<{
    user: Pick<SessionUser, "id" | "externalId" | "name" | "username" | "email">;
  } | null>;
  findProjectScope(
    projectId: string,
    userId: string,
  ): Promise<{ project: { id: string }; organization: { id: string } } | null>;
  /** The project's scorers, for an import to find by name. */
  scorers(projectId: string): Promise<readonly ScorerOption[]>;
  /** An admin support session may look but not change. */
  isRestricted(): Promise<boolean>;
  store: Pick<
    typeof store,
    "countDashboards" | "createDashboard" | "updateDashboard" | "deleteDashboard" | "changeWidgets"
  >;
  observe(fields: {
    project_id: string;
    organization_id: string;
    dashboard_id: string;
    actor: string;
    action: DashboardActionInput["action"];
  }): Promise<void>;
}

/** The refusals a person can act on. Anything else is a failure. */
class Refusal extends Error {}

const layoutsSchema = z.record(z.string(), gridPositionSchema);

const INVALID = "The dashboard change is invalid.";
const MISSING = "This dashboard no longer exists.";

/** One change to a project's dashboards: membership first, then the widget's rules. */
export async function changeDashboard(
  raw: unknown,
  deps: DashboardActionDeps,
): Promise<DashboardActionResult> {
  const input = record(raw);
  const projectId = parseProjectUuid(text(input.projectId));
  if (!projectId) return { ok: false, error: INVALID };
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to change dashboards." };
  const scope = await deps.findProjectScope(projectId, session.user.id);
  if (!scope) return { ok: false, error: "You cannot change this project's dashboards." };
  if (await deps.isRestricted())
    return { ok: false, error: "A support session cannot change dashboards." };

  const { user } = session;
  const actor = user.externalId;
  const editor = { updatedBy: actor, updatedByName: user.name || user.username || user.email };
  try {
    const { id: dashboardId, missingScorers } = await apply(input, scope.project.id, editor, deps);
    await deps.observe({
      project_id: scope.project.id,
      organization_id: scope.organization.id,
      dashboard_id: dashboardId,
      actor,
      action: input.action as DashboardActionInput["action"],
    });
    return { ok: true, dashboardId, ...(missingScorers?.length ? { missingScorers } : {}) };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.message };
    throw err;
  }
}

/** The dashboard it changed. */
async function apply(
  input: Record<string, unknown>,
  projectId: string,
  editor: DashboardEditor,
  { store, scorers }: DashboardActionDeps,
): Promise<{ id: string; missingScorers?: string[] }> {
  switch (input.action) {
    case "create":
    case "create-starter": {
      const starter = input.action === "create-starter";
      const name = starter ? STARTER_NAME : dashboardName(input.name);
      await checkRoom(projectId, store);
      const widgets = starter ? starterWidgets() : [];
      return store.createDashboard({ projectId, name, widgets, ...editor });
    }
    case "import": {
      const read = importDashboard(input.document, await scorers(projectId));
      if (!read.ok) throw new Refusal(read.error);
      await checkRoom(projectId, store);
      const { widgets, missingScorers, ...rest } = read.dashboard;
      const { id } = await store.createDashboard({
        projectId,
        ...rest,
        widgets: widgets.map((widget) => ({ ...widget, id: randomUUID() })),
        ...editor,
      });
      return { id, missingScorers };
    }
    case "rename": {
      const id = dashboardIdOf(input);
      const name = dashboardName(input.name);
      if (!(await store.updateDashboard({ projectId, id, set: { name }, ...editor })))
        throw new Refusal(MISSING);
      return { id };
    }
    case "save-defaults": {
      const id = dashboardIdOf(input);
      const set = checkedDefaults(input.defaults);
      const check = (widgets: DashboardWidget[]) =>
        checkFilters(widgets.filter(isWidget), set.filters);
      if (!(await store.updateDashboard({ projectId, id, set, check, ...editor })))
        throw new Refusal(MISSING);
      return { id };
    }
    case "delete": {
      const id = dashboardIdOf(input);
      if (!(await store.deleteDashboard(projectId, id))) throw new Refusal(MISSING);
      return { id };
    }
    case "add-widget":
    case "edit-widget":
    case "save-layout":
    case "remove-widget": {
      const id = dashboardIdOf(input);
      const change = widgetChange(input);
      const outcome = await store.changeWidgets({ projectId, id, change, ...editor });
      if (outcome === "missing") throw new Refusal(MISSING);
      return { id };
    }
    default:
      throw new Refusal(INVALID);
  }
}

/** The next widget list. */
function widgetChange(
  input: Record<string, unknown>,
): (widgets: DashboardWidget[], filters: DashboardFilters) => DashboardWidget[] {
  if (input.action === "add-widget") {
    const widget = checkedWidget(input.widget);
    const missing = text(input.missingScorer).slice(0, 200);
    if (!hasNoNul(missing)) throw new Refusal(NUL_PROBLEM);
    const back = gridPositionSchema.safeParse(input.layout);
    return (widgets, filters) => {
      checkFilters([widget], filters);
      if (widgets.length >= MAX_WIDGETS)
        throw new Refusal(`A dashboard can have ${MAX_WIDGETS} widgets.`);
      const layout = back.success ? back.data : freePosition(widgets, defaultSize(widget.chart));
      const added = { ...withId(widget, layout), ...(missing ? { missingScorer: missing } : {}) };
      return compacted<DashboardWidget>([...widgets, added], added.id);
    };
  }
  if (input.action === "save-layout") {
    const saved = layoutsSchema.safeParse(input.layouts);
    if (!saved.success) throw new Refusal(INVALID);
    // Only where they are: a widget added or removed meanwhile stays added or removed.
    return (widgets) =>
      compacted(
        widgets.map((widget) => ({ ...widget, layout: saved.data[widget.id] ?? widget.layout })),
      );
  }
  const widgetId = text(input.widgetId);
  const indexIn = (widgets: DashboardWidget[]) => {
    const index = widgets.findIndex((widget) => widget.id === widgetId);
    if (index < 0) throw new Refusal("This widget no longer exists.");
    return index;
  };
  if (input.action === "edit-widget") {
    const widget = checkedWidget(input.widget);
    return (widgets, filters) => {
      checkFilters([widget], filters);
      const index = indexIn(widgets);
      return widgets.with(index, { ...widget, id: widgetId, layout: widgets[index].layout });
    };
  }
  return (widgets) => compacted(widgets.toSpliced(indexIn(widgets), 1));
}

function checkedWidget(raw: unknown): WidgetInput {
  const parsed = parseWidget(raw);
  if (!parsed.ok) throw new Refusal(parsed.error);
  return parsed.widget;
}

/** A widget's filter and the dashboard's are one filter of the traces it shows. */
function checkFilters(widgets: readonly WidgetInput[], filters: DashboardFilters): void {
  const problem = filtersProblem(
    widgets.map(({ query }) => query),
    filters,
  );
  if (problem) throw new Refusal(problem);
}

async function checkRoom(
  projectId: string,
  { countDashboards }: DashboardActionDeps["store"],
): Promise<void> {
  if ((await countDashboards(projectId)) >= MAX_DASHBOARDS)
    throw new Refusal(`A project can have ${MAX_DASHBOARDS} dashboards.`);
}

function checkedDefaults(raw: unknown): DashboardDefaults {
  const { filters, range } = record(raw);
  const parsed = defaultsSchema.safeParse({ filters, range });
  if (!parsed.success) throw new Refusal(filtersRefusal(parsed.error));
  return parsed.data;
}

function dashboardName(raw: unknown): string {
  const name = text(raw).trim();
  if (!name) throw new Refusal("Give the dashboard a name.");
  if (name.length > MAX_DASHBOARD_NAME)
    throw new Refusal(`A dashboard name can have ${MAX_DASHBOARD_NAME} characters.`);
  if (!hasNoNul(name)) throw new Refusal(NUL_PROBLEM);
  return name;
}

function dashboardIdOf(input: Record<string, unknown>): string {
  const id = parseProjectUuid(text(input.dashboardId));
  if (!id) throw new Refusal(INVALID);
  return id;
}

function starterWidgets(): Widget[] {
  const placed: Widget[] = [];
  for (const widget of STARTER_WIDGETS) placed.push(withId(widget, freePosition(placed)));
  return placed;
}

function withId(widget: WidgetInput, layout: GridPosition): Widget {
  return { ...widget, id: randomUUID(), layout };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
