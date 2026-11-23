import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { sentimentAnalysisEnabled } from "@/lib/readings/trace-signals/outcomes/gate";
import { sessionReplayHref } from "@/lib/views/session-replay/view";
import { loadTurnConversation, type TurnConversation } from "@/lib/views/traces/sentiment/example";
import { loadTurnDetail, type TurnDetail } from "@/lib/views/traces/turn-detail";

/** One turn as Traces shows it: its calls, and the words around it. */
export interface TurnView {
  turn: TurnDetail;
  conversation: TurnConversation | null;
  /** The session's replay. */
  sessionHref: string;
}

type Organization = Parameters<typeof sentimentAnalysisEnabled>[0];

/** The turn for the Traces page and the Panel beside a list; null when the project has none. */
export async function loadTurnView(
  projectId: string,
  turnId: string,
  organization: Organization,
): Promise<TurnView | null> {
  const turn = await withStatementTimeout((db) => loadTurnDetail(projectId, turnId, db), {
    operation: "trace_turn_detail",
  });
  if (!turn) return null;
  // Behind `cloud-sentiment-analysis`: the words around the turn. A failed read leaves the page as it was.
  const conversation = (await sentimentAnalysisEnabled(organization).catch(() => false))
    ? await withStatementTimeout((db) => loadTurnConversation(db, projectId, turnId), {
        operation: "trace_turn_conversation",
      }).catch(() => null)
    : null;
  return { turn, conversation, sessionHref: sessionReplayHref(projectId, turn.sessionId) };
}
