import { TurnDetailView } from "@/components/console/traces/TurnDetailView";
import type { PanelTurn } from "@/components/console/turn-panel/useTurnPanel";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { turnTracesHref } from "@/lib/readings/trace-signals/view";
import { parseTurnPeek } from "@/lib/views/traces/turn-peek";
import { loadTurnView } from "@/lib/views/traces/turn-view";

/**
 * The turn a list page's address opens in its Panel, read on the server so
 * the Panel shows what Traces shows. Null when the address opens none.
 */
export async function loadPanelTurn({
  projectId,
  organization,
  search,
  operation,
}: {
  projectId: string;
  organization: Parameters<typeof loadTurnView>[2];
  search: Readonly<Record<string, string | string[] | undefined>>;
  operation: string;
}): Promise<PanelTurn | null> {
  const peek = parseTurnPeek(search);
  if (!peek) return null;
  const view = await loadOrFallback({
    operation,
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () => loadTurnView(projectId, peek.turnId, organization, peek.eventId),
  });
  return {
    id: peek.turnId,
    href: turnTracesHref(projectId, peek.turnId, peek.eventId),
    view: view ? (
      <TurnDetailView
        projectId={projectId}
        turn={view.turn}
        focusEventId={peek.eventId}
        sessionHref={view.sessionHref}
        conversation={view.conversation}
        hallucinations={view.hallucinations}
        embedded
      />
    ) : null,
  };
}
