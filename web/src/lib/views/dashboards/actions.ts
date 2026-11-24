import { randomUUID } from "node:crypto";
import { parseProjectUuid } from "@/lib/console/scope/cookie";
import type { MetricFeatures } from "@/lib/synthesis/metrics/catalog";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import { STARTER_NAME, STARTER_WIDGETS } from "@/lib/views/dashboards/starter";
import type * as store from "@/lib/views/dashboards/store";
import {
  MAX_DASHBOARD_NAME,
  MAX_DASHBOARDS,
  MAX_WIDGETS,
  type Widget,
  type WidgetInput,
} from "@/lib/views/dashboards/types";

export type DashboardActionInput = { projectId: string } & (
  | { action: "create"; name: string }
  | { action: "create-starter" }
  | { action: "rename"; dashboardId: string; name: string }
  | { action: "delete"; dashboardId: string }
  /** At the end, or back where it was (`index`, the undo of a removal). */
  | { action: "add-widget"; dashboardId: string; widget: WidgetInput; index?: number }
  | { action: "edit-widget"; dashboardId: string; widgetId: string; widget: WidgetInput }
  | { action: "move-widget"; dashboardId: string; widgetId: string; direction: "up" | "down" }
  | { action: "remove-widget"; dashboardId: string; widgetId: string }
);

export type DashboardActionResult =
  | { ok: true; dashboardId: string }
  | { ok: false; error: string };

export interface DashboardActionDeps {
  getSession(): Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope(
    projectId: string,
    userId: string,
  ): Promise<{ project: { id: string }; organization: { id: string } } | null>;
  enabled(subject: { organizationId: string }): Promise<boolean>;
  /** The switches that decide which metrics a widget may use. */
  features(subject: {
    projectId: string;
    organizationId: string;
    actor: string;
  }): Promise<MetricFeatures>;
  /** An admin support session may look but not change. */
  isRestricted(): Promise<boolean>;
  store: Pick<
    typeof store,
    "listDashboards" | "createDashboard" | "renameDashboard" | "deleteDashboard" | "changeWidgets"
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

const INVALID = "The dashboard change is invalid.";
const MISSING = "This dashboard no longer exists.";

/** One change to a project's dashboards: membership and the flag first, then the widget's rules. */
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
  if (!(await deps.enabled({ organizationId: scope.organization.id })))
    return { ok: false, error: "Dashboards are off for this project." };
  if (await deps.isRestricted())
    return { ok: false, error: "A support session cannot change dashboards." };

  const actor = session.user.externalId;
  try {
    const dashboardId = await apply(input, scope.project.id, actor, deps, () =>
      deps.features({
        projectId: scope.project.id,
        organizationId: scope.organization.id,
        actor,
      }),
    );
    await deps.observe({
      project_id: scope.project.id,
      organization_id: scope.organization.id,
      dashboard_id: dashboardId,
      actor,
      action: input.action as DashboardActionInput["action"],
    });
    return { ok: true, dashboardId };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.message };
    throw err;
  }
}

/** The id of the dashboard it changed. */
async function apply(
  input: Record<string, unknown>,
  projectId: string,
  updatedBy: string,
  { store }: DashboardActionDeps,
  features: () => Promise<MetricFeatures>,
): Promise<string> {
  switch (input.action) {
    case "create":
    case "create-starter": {
      const starter = input.action === "create-starter";
      const name = starter ? STARTER_NAME : dashboardName(input.name);
      if ((await store.listDashboards(projectId)).length >= MAX_DASHBOARDS)
        throw new Refusal(`A project can have ${MAX_DASHBOARDS} dashboards.`);
      const widgets = starter ? STARTER_WIDGETS.map(withId) : [];
      return (await store.createDashboard({ projectId, name, widgets, updatedBy })).id;
    }
    case "rename": {
      const id = dashboardIdOf(input);
      const name = dashboardName(input.name);
      if (!(await store.renameDashboard({ projectId, id, name, updatedBy })))
        throw new Refusal(MISSING);
      return id;
    }
    case "delete": {
      const id = dashboardIdOf(input);
      if (!(await store.deleteDashboard(projectId, id))) throw new Refusal(MISSING);
      return id;
    }
    case "add-widget":
    case "edit-widget":
    case "move-widget":
    case "remove-widget": {
      const id = dashboardIdOf(input);
      const change = await widgetChange(input, features);
      const outcome = await store.changeWidgets({ projectId, id, updatedBy, change });
      if (outcome === "missing") throw new Refusal(MISSING);
      return id;
    }
    default:
      throw new Refusal(INVALID);
  }
}

/** The next widget list, or null when the change leaves it as it is (a move past an end). */
async function widgetChange(
  input: Record<string, unknown>,
  features: () => Promise<MetricFeatures>,
): Promise<(widgets: Widget[]) => Widget[] | null> {
  if (input.action === "add-widget") {
    const widget = withId(checkedWidget(input.widget, await features()));
    const index = Number.isSafeInteger(input.index) ? (input.index as number) : MAX_WIDGETS;
    return (widgets) => {
      if (widgets.length >= MAX_WIDGETS)
        throw new Refusal(`A dashboard can have ${MAX_WIDGETS} widgets.`);
      return widgets.toSpliced(index, 0, widget);
    };
  }
  const widgetId = text(input.widgetId);
  const indexIn = (widgets: Widget[]) => {
    const index = widgets.findIndex((widget) => widget.id === widgetId);
    if (index < 0) throw new Refusal("This widget no longer exists.");
    return index;
  };
  if (input.action === "edit-widget") {
    const widget = { ...checkedWidget(input.widget, await features()), id: widgetId };
    return (widgets) => widgets.with(indexIn(widgets), widget);
  }
  if (input.action === "remove-widget") return (widgets) => widgets.toSpliced(indexIn(widgets), 1);
  if (input.direction !== "up" && input.direction !== "down") throw new Refusal(INVALID);
  const step = input.direction === "up" ? -1 : 1;
  return (widgets) => {
    const index = indexIn(widgets);
    const other = index + step;
    if (other < 0 || other >= widgets.length) return null;
    return widgets.with(index, widgets[other]).with(other, widgets[index]);
  };
}

function checkedWidget(raw: unknown, features: MetricFeatures): WidgetInput {
  const parsed = parseWidget(raw, features);
  if (!parsed.ok) throw new Refusal(parsed.error);
  return parsed.widget;
}

function dashboardName(raw: unknown): string {
  const name = text(raw).trim();
  if (!name) throw new Refusal("Give the dashboard a name.");
  if (name.length > MAX_DASHBOARD_NAME)
    throw new Refusal(`A dashboard name can have ${MAX_DASHBOARD_NAME} characters.`);
  return name;
}

function dashboardIdOf(input: Record<string, unknown>): string {
  const id = parseProjectUuid(text(input.dashboardId));
  if (!id) throw new Refusal(INVALID);
  return id;
}

function withId(widget: WidgetInput): Widget {
  return { ...widget, id: randomUUID() };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
