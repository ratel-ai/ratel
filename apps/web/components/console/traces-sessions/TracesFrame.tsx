import type { ReactNode } from "react";
import { TracesSessionsProvider } from "./sessions-context";

/**
 * The Traces area's frame (`cloud-traces-sessions`): the first tab named
 * Sessions, and each of the Sessions, Spans and Logs tabs with its own
 * summary at the top (`TabSummary`). Nothing sits above the tabs. Off, the
 * pages render alone, as before.
 */
export function TracesFrame({ enabled, children }: { enabled: boolean; children?: ReactNode }) {
  if (!enabled) return children;
  return <TracesSessionsProvider>{children}</TracesSessionsProvider>;
}
