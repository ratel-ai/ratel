import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { buildTraceContentView, preferSpanContent } from "@/lib/synthesis/traces/content-view";
import { loadPayloadCalls, loadPayloadContentSafely } from "@/lib/synthesis/traces/payload-content";
import { getTraceSpansWithTruncation } from "@/lib/synthesis/traces/queries";
import { buildTraceWaterfall } from "@/lib/synthesis/traces/waterfall";
import { loadTurnTraceIds } from "@/lib/views/session-chat/turn-traces";
import { loadTurnDetail } from "@/lib/views/traces/turn-detail";
import { recordedConversation, type TurnContent } from "./domain/from-turn";

/**
 * The recorded text of a turn, from each trace of it. Null when the turn is not in the project.
 * Captured text: call it only for a member, with the project's content reading on.
 */
export async function loadTurnContent(
  projectId: string,
  turnId: string,
): Promise<TurnContent | null> {
  const found = await withStatementTimeout(
    async (db) => {
      const turn = await loadTurnDetail(projectId, turnId, db);
      if (!turn) return null;
      const traceIds = (await loadTurnTraceIds(projectId, [turnId], db)).get(turnId) ?? [];
      return { turn, traceIds };
    },
    { operation: "eval_case_turn" },
  );
  if (!found) return null;
  const { turn, traceIds } = found;
  const contents = await Promise.all(traceIds.map((traceId) => traceContent(projectId, traceId)));
  const searched = turn.calls.find((call) => call.query?.state === "captured")?.query;
  return {
    ask:
      contents.find(({ ask }) => ask)?.ask ??
      turn.linked?.asked ??
      (searched?.state === "captured" ? searched.text : null),
    messages: contents.flatMap(({ view }) => view.messages),
    toolCalls: contents.flatMap(({ view }) => view.toolCalls),
    conversation: conversationOf(contents.map(({ conversation }) => conversation)),
  };
}

/** The first ask of the turn, and the last answer. */
function conversationOf(
  conversations: ReadonlyArray<TurnContent["conversation"]>,
): TurnContent["conversation"] {
  const known = conversations.flatMap((conversation) => (conversation ? [conversation] : []));
  const [first] = known;
  return first ? { ...first, answer: known.at(-1)?.answer ?? null } : null;
}

async function traceContent(projectId: string, traceId: string) {
  const { spans } = await getTraceSpansWithTruncation(projectId, traceId);
  const ordered = buildTraceWaterfall(spans).rows.map((row) => row.span);
  const payload = await loadPayloadContentSafely(projectId, traceId, "eval_case_turn");
  const calls = await withStatementTimeout((db) => loadPayloadCalls(projectId, traceId, db), {
    operation: "eval_case_turn_calls",
  });
  return {
    conversation: recordedConversation(calls.map((call) => call.payload)),
    ask: payload?.ask ?? null,
    view: preferSpanContent(buildTraceContentView(ordered), payload?.view ?? null),
  };
}
