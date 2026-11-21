import type { TraceViewProps } from "@/lib/views/traces/trace-view-types";
import type { ToolSuccess } from "../../shell/state";

/** get_trace's view data (lib/mcp/operations/observability.ts), or null when the result has none. */
export function readTraceView(result: Pick<ToolSuccess, "view">): TraceViewProps | null {
  const view = result.view as { kind?: unknown; props?: Partial<TraceViewProps> } | undefined;
  const props = view?.kind === "trace" ? view.props : undefined;
  if (
    !props ||
    typeof props.traceId !== "string" ||
    typeof props.projectId !== "string" ||
    !Array.isArray(props.waterfall?.rows)
  )
    return null;
  return props as TraceViewProps;
}
