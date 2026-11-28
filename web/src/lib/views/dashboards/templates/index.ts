import { randomUUID } from "node:crypto";
import { notIndexed } from "@/lib/synthesis/rql/domain/properties";
import { defaultSize, freePosition } from "@/lib/views/dashboards/layout";
import { AGENTS_TEMPLATE } from "@/lib/views/dashboards/templates/agents";
import { BY_CUSTOMER_TEMPLATE } from "@/lib/views/dashboards/templates/by-customer";
import { CONTEXT_USE_TEMPLATE } from "@/lib/views/dashboards/templates/context-use";
import { COST_TEMPLATE } from "@/lib/views/dashboards/templates/cost";
import { MODELS_TEMPLATE } from "@/lib/views/dashboards/templates/models";
import { QUALITY_TEMPLATE } from "@/lib/views/dashboards/templates/quality";
import { RELIABILITY_TEMPLATE } from "@/lib/views/dashboards/templates/reliability";
import { TOOLS_TEMPLATE } from "@/lib/views/dashboards/templates/tools";
import { TRACES_OVERVIEW_TEMPLATE } from "@/lib/views/dashboards/templates/traces-overview";
import type { DashboardTemplate, TemplateWidget } from "@/lib/views/dashboards/templates/types";
import { USERS_SESSIONS_TEMPLATE } from "@/lib/views/dashboards/templates/users-sessions";
import { MAX_DASHBOARD_NAME, type Widget } from "@/lib/views/dashboards/types";

/** The templates of the gallery, in its order. */
export const DASHBOARD_TEMPLATES: readonly DashboardTemplate[] = [
  TOOLS_TEMPLATE,
  COST_TEMPLATE,
  RELIABILITY_TEMPLATE,
  TRACES_OVERVIEW_TEMPLATE,
  USERS_SESSIONS_TEMPLATE,
  QUALITY_TEMPLATE,
  MODELS_TEMPLATE,
  AGENTS_TEMPLATE,
  CONTEXT_USE_TEMPLATE,
  BY_CUSTOMER_TEMPLATE,
];

/** What every project gets one time, as normal dashboards (`defaults.ts`). */
export const DEFAULT_TEMPLATE_IDS: readonly string[] = [
  TOOLS_TEMPLATE.id,
  COST_TEMPLATE.id,
  RELIABILITY_TEMPLATE.id,
];

export function getTemplate(id: string): DashboardTemplate | null {
  return DASHBOARD_TEMPLATES.find((template) => template.id === id) ?? null;
}

/** A dashboard to store from a template, or why the template cannot make one. */
export type TemplateDashboard =
  | { ok: true; template: DashboardTemplate; name: string; widgets: Widget[] }
  | { ok: false; error: string };

/**
 * The dashboard a template makes, with each widget at its place. `By customer` takes a property
 * that `indexed` (the project's own indexed properties) holds. Each widget gets a new id.
 */
export function templateDashboard(
  id: string,
  { property, indexed }: { property?: string; indexed: readonly string[] },
): TemplateDashboard {
  const template = getTemplate(id);
  if (!template) return { ok: false, error: `There is no dashboard template "${shown(id)}".` };
  if (!template.property)
    return { ok: true, template, name: template.name, widgets: placed(template.widgets) };
  const name = property?.trim() ?? "";
  if (!name)
    return { ok: false, error: `${template.name} needs an indexed trace property: give its name.` };
  if (!indexed.includes(name)) {
    const { message, fix } = notIndexed(name, { indexed });
    return { ok: false, error: `${message} ${fix}` };
  }
  return {
    ok: true,
    template,
    name: `${template.name}: ${name}`.slice(0, MAX_DASHBOARD_NAME),
    widgets: placed(template.widgets(name)),
  };
}

/** Each widget at the first free place of its size, in the template's order. */
function placed(widgets: readonly TemplateWidget[]): Widget[] {
  const out: Widget[] = [];
  for (const { size, ...widget } of widgets)
    out.push({
      ...widget,
      id: randomUUID(),
      layout: freePosition(out, size ?? defaultSize(widget.chart)),
    });
  return out;
}

function shown(text: string): string {
  return text.slice(0, 80);
}
