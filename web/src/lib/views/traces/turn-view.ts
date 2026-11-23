import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { hallucinationDetectionEnabled } from "@/lib/readings/trace-signals/hallucinations/gate";
import { sentimentAnalysisEnabled } from "@/lib/readings/trace-signals/outcomes/gate";
import { loadTurnMarkers, type TurnMarker } from "@/lib/views/health/hallucinations/turn-markers";
import { sessionReplayHref } from "@/lib/views/session-replay/view";
import { loadTurnConversation, type TurnConversation } from "@/lib/views/traces/sentiment/example";
import { loadTurnDetail, type TurnDetail } from "@/lib/views/traces/turn-detail";

/** One turn as Traces shows it: its calls, the hallucinations marked on them, and the words around it. */
export interface TurnView {
  turn: TurnDetail;
  hallucinations: TurnMarker[];
  conversation: TurnConversation | null;
  /** The session's replay; with a hallucination in the turn, opened on its bookmark. */
  sessionHref: string;
}

type Organization = Parameters<typeof hallucinationDetectionEnabled>[0] &
  Parameters<typeof sentimentAnalysisEnabled>[0];

/** The call the replay opens on: the focused one when it has a marker, else the turn's first marked call. */
export function replayFocus(
  turn: Pick<TurnDetail, "calls">,
  markers: ReadonlyArray<Pick<TurnMarker, "stepOrdinal">>,
  focusEventId: string | null,
): string | null {
  const marked = turn.calls.filter((call) =>
    markers.some((marker) => marker.stepOrdinal === call.ordinal),
  );
  return (marked.find((call) => call.eventId === focusEventId) ?? marked[0])?.eventId ?? null;
}

/** The turn for the Traces page and the panel beside the Hallucinations list; null when the project has none. */
export async function loadTurnView(
  projectId: string,
  turnId: string,
  organization: Organization,
  focusEventId: string | null,
): Promise<TurnView | null> {
  const turn = await withStatementTimeout((db) => loadTurnDetail(projectId, turnId, db), {
    operation: "trace_turn_detail",
  });
  if (!turn) return null;
  // Behind `cloud-hallucination-detection`: the turn's hallucinations, marked on the calls they sit on.
  const [sentimentOn, hallucinationsOn] = await Promise.all([
    sentimentAnalysisEnabled(organization).catch(() => false),
    hallucinationDetectionEnabled(organization).catch(() => false),
  ]);
  const hallucinations = hallucinationsOn
    ? await withStatementTimeout((db) => loadTurnMarkers(db, projectId, turnId), {
        operation: "trace_turn_hallucinations",
      }).catch(() => [])
    : [];
  // Behind either flag: the words around the turn, which explain why it shows up on those pages. A failed read leaves the page as it was.
  const conversation =
    sentimentOn || hallucinationsOn
      ? await withStatementTimeout((db) => loadTurnConversation(db, projectId, turnId), {
          operation: "trace_turn_conversation",
        }).catch(() => null)
      : null;
  const replay = sessionReplayHref(projectId, turn.sessionId);
  const focus = replayFocus(turn, hallucinations, focusEventId);
  return {
    turn,
    hallucinations,
    conversation,
    sessionHref: focus ? `${replay}?focus=${encodeURIComponent(focus)}` : replay,
  };
}
