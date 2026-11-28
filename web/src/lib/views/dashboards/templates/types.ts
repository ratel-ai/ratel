import type { GridPosition, WidgetInput } from "@/lib/views/dashboards/types";

/**
 * A dashboard template (decision `dashboard-templates`): a pure value that makes a normal
 * dashboard. Once made, the dashboard is the project's own: a later change of the template does
 * not change it.
 */

/** The data a template reads. Each one is a cheap fact of the project (`data.ts`). */
export type TemplateNeed =
  | "traces"
  | "tool_calls"
  | "scores"
  | "sessions"
  | "users"
  | "prompts"
  | "agents"
  | "property";

/** A widget of a template: what the editor holds, and its size on the grid. */
export type TemplateWidget = WidgetInput & { size?: Pick<GridPosition, "w" | "h"> };

interface TemplateBase {
  /** Stable: a stored default names its template by it. */
  id: string;
  name: string;
  /** One line: what the dashboard shows. */
  description: string;
  /** A sentence a person could type in Ask in words for the same dashboard. */
  prompt: string;
  needs: readonly TemplateNeed[];
}

/** Most templates have fixed widgets. `By customer` is a function of one indexed property. */
export type DashboardTemplate = TemplateBase &
  (
    | { property: false; widgets: readonly TemplateWidget[] }
    | { property: true; widgets: (property: string) => readonly TemplateWidget[] }
  );

/** A template as a card of the gallery: what it shows, and whether the project has its data. */
export interface TemplateCard {
  id: string;
  name: string;
  description: string;
  /** It takes an indexed trace property first (By customer). */
  property: boolean;
  has: boolean;
  /** Why not, one line per missing need: "No scores yet". */
  missing: string[];
}
