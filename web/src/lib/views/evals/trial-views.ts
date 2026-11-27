import { and, eq } from "drizzle-orm";
import { traceTurns } from "@/lib/ledger/schema";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadSessionLens } from "@/lib/views/session-replay/annotations-load";
import { loadSessionTimeline } from "@/lib/views/session-replay/load";
import { buildSessionView, type SessionView } from "@/lib/views/session-replay/view";
import { loadTraceViewProps } from "@/lib/views/traces/trace-view-props";
import type { TraceViewProps } from "@/lib/views/traces/trace-view-types";

/** The trace view and the session replay of one trial, from the trace that its run made. */
export type TrialViews = {
  trace: TraceViewProps | null;
  replay: SessionView | null;
  /** The session of the replay, for its link. */
  sessionId: string | null;
};

const NONE: TrialViews = { trace: null, replay: null, sessionId: null };
/** An OTLP turn is the run of one trace: its key is `otlp:<trace id>`. */
const OTLP_KEY = "otlp:";

/** Null parts when the trial stored no trace, or its spans are gone. */
export async function loadTrialViews(
  projectId: string,
  traceId: string | null,
  tracesHref: string,
): Promise<TrialViews> {
  if (!traceId) return NONE;
  const [trace, replay] = await Promise.all([
    loadTraceViewProps(projectId, traceId, {
      listHref: tracesHref,
      compareHref: `${tracesHref}?compare=${encodeURIComponent(traceId)}`,
      tab: undefined,
      spanId: null,
    }),
    loadReplay(projectId, traceId),
  ]);
  return { trace, ...replay };
}

async function loadReplay(projectId: string, traceId: string) {
  return withStatementTimeout(
    async (db) => {
      const [turn] = await db
        .select({ sessionId: traceTurns.sessionId })
        .from(traceTurns)
        .where(
          and(
            eq(traceTurns.projectId, projectId),
            eq(traceTurns.turnKey, `${OTLP_KEY}${traceId.toLowerCase()}`),
          ),
        )
        .limit(1);
      if (!turn) return { replay: null, sessionId: null };
      const timeline = await loadSessionTimeline(projectId, turn.sessionId, db);
      if (!timeline) return { replay: null, sessionId: turn.sessionId };
      const replay = buildSessionView(timeline, await loadSessionLens(projectId, timeline, db));
      return { replay, sessionId: turn.sessionId };
    },
    { operation: "eval_trial_replay" },
  );
}
