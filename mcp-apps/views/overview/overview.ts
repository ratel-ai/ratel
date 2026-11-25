import type { FocusedOverviewData } from "@/lib/views/home/focused-load";
import type { ToolSuccess } from "../../shell/state";

/** The page's data, as it arrives: a date is text. */
export type OverviewViewData = Omit<FocusedOverviewData, "lastEventAt">;

export interface OverviewView {
  overview: OverviewViewData;
  /** The Agents and MCP servers pages exist. */
  linked: boolean;
}

/** get_overview's view data (web/src/lib/mcp/operations/overview.ts), or null when the result has none. */
export function readOverviewView(result: Pick<ToolSuccess, "view">): OverviewView | null {
  const view = result.view as
    | { kind?: unknown; overview?: Partial<OverviewViewData>; linked?: unknown }
    | undefined;
  const overview = view?.kind === "overview" ? view.overview : undefined;
  if (
    !overview ||
    typeof overview.project?.id !== "string" ||
    typeof overview.root !== "string" ||
    !Array.isArray(overview.layout)
  )
    return null;
  return { overview: overview as OverviewViewData, linked: view?.linked === true };
}
