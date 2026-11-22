/**
 * Custom dashboards (RC-888): the pure rules. Who
 * opens and edits a dashboard, its name, and the widget limit. The tables are
 * `dashboards` and `dashboard_widgets` (lib/db/schema.ts).
 */

export type DashboardSharing = "private" | "project";

export interface Dashboard {
  id: string;
  projectId: string;
  name: string;
  /** The creator's Clerk id. */
  createdBy: string;
  sharing: DashboardSharing;
  createdAt: Date;
  updatedAt: Date;
}

export interface DashboardWidget {
  id: string;
  position: number;
  /** The stored spec: checked again each time it is read (./spec.ts). */
  spec: unknown;
}

export type Checked = { ok: true; value: string } | { ok: false };

export const WIDGET_LIMIT = 20;
export const MAX_NAME_LENGTH = 80;
export const DASHBOARD_SHARING: readonly DashboardSharing[] = ["private", "project"];

/**
 * Whether a project member opens a dashboard: its creator always, every other
 * member only when it is shared with the project. Membership of the project
 * is checked before this rule; a dashboard nobody may open reads not-found.
 * A caller with no person (null: a project API key over MCP) opens only the
 * dashboards shared with the project.
 */
export function canOpenDashboard(
  dashboard: Pick<Dashboard, "createdBy" | "sharing">,
  externalId: string | null,
): boolean {
  return (
    (externalId !== null && dashboard.createdBy === externalId) || dashboard.sharing === "project"
  );
}

/**
 * Whether a project member edits a dashboard: the creator edits a private
 * one, every member edits a project one. The same people who open it.
 */
export function canEditDashboard(
  dashboard: Pick<Dashboard, "createdBy" | "sharing">,
  externalId: string,
): boolean {
  return canOpenDashboard(dashboard, externalId);
}

/**
 * Whether a person changes who sees a dashboard (RC-889): its creator only.
 * Every member edits a project dashboard, but sharing is a decision of the
 * owner. Otherwise any member could make a shared dashboard private and so
 * take it away from its creator, or the reverse once the creator shares it.
 */
export function canShareDashboard(
  dashboard: Pick<Dashboard, "createdBy">,
  externalId: string | null,
): boolean {
  return externalId !== null && dashboard.createdBy === externalId;
}

/** Whether a dashboard with `count` widgets takes one more. */
export function canAddWidget(count: number): boolean {
  return count < WIDGET_LIMIT;
}

/** A dashboard name: 1 to 80 characters once trimmed. */
export function validateDashboardName(value: unknown): Checked {
  if (typeof value !== "string") return { ok: false };
  const name = value.trim().replace(/\s+/g, " ");
  return name.length > 0 && name.length <= MAX_NAME_LENGTH
    ? { ok: true, value: name }
    : { ok: false };
}

/**
 * The widget order after moving one widget up or down by one place, as widget
 * ids, or null when the widget is not there or cannot move that way.
 */
export function moveWidget(
  widgets: readonly Pick<DashboardWidget, "id" | "position">[],
  id: string,
  direction: "up" | "down",
): string[] | null {
  const ordered = [...widgets].sort((a, b) => a.position - b.position);
  const index = ordered.findIndex((widget) => widget.id === id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) return null;
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  return ordered.map((widget) => widget.id);
}
