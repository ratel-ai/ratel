import { and, asc, eq } from "drizzle-orm";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import type { getDb } from "@/lib/platform/db/client";
import { KIND_LABEL, kindOf } from "@/lib/readings/trace-signals/hallucinations/kinds";
import { traceHallucinations } from "@/lib/readings/trace-signals/schema";
import { catalogEntryOf } from "@/lib/readings/trace-signals/self-corrections/issues";

/**
 * A session's hallucinations as bookmarks on the replay bar, each on the
 * step of the call it sits on. Closed values and ids only.
 */
export interface SessionFinding {
  /** The call's own event (`trace_events.id`). */
  eventId: string;
  kind: string;
  toolId: string;
}

export interface TrackBookmark {
  stepIndex: number;
  label: string;
  /** The one the reader came from. */
  current: boolean;
}

export async function loadSessionFindings(
  db: Pick<ReturnType<typeof getDb>, "select">,
  projectId: string,
  sessionId: string,
): Promise<SessionFinding[]> {
  return db
    .select({
      eventId: traceTurnSteps.traceEventId,
      kind: traceHallucinations.kind,
      toolId: traceHallucinations.toolId,
    })
    .from(traceHallucinations)
    .innerJoin(traceTurns, eq(traceTurns.id, traceHallucinations.turnId))
    .innerJoin(
      traceTurnSteps,
      and(
        eq(traceTurnSteps.turnId, traceHallucinations.turnId),
        eq(traceTurnSteps.ordinal, traceHallucinations.stepOrdinal),
      ),
    )
    .where(and(eq(traceHallucinations.projectId, projectId), eq(traceTurns.sessionId, sessionId)))
    .orderBy(asc(traceHallucinations.occurredAt), asc(traceHallucinations.kind));
}

/** The findings on the track's steps (pure): one bookmark per step; a call the track does not show has none. */
export function trackBookmarks(
  segments: ReadonlyArray<{ stepIndex: number | null; eventId: string | null }>,
  findings: readonly SessionFinding[],
  focusEventId: string | null,
): TrackBookmark[] {
  const stepOf = new Map(
    segments.flatMap((segment) =>
      segment.eventId !== null && segment.stepIndex !== null
        ? [[segment.eventId, segment.stepIndex] as const]
        : [],
    ),
  );
  const byStep = new Map<number, TrackBookmark>();
  for (const finding of findings) {
    const kind = kindOf(finding.kind);
    const stepIndex = stepOf.get(finding.eventId);
    if (!kind || stepIndex === undefined || byStep.has(stepIndex)) continue;
    byStep.set(stepIndex, {
      stepIndex,
      label: `${KIND_LABEL[kind]}: ${catalogEntryOf(finding.toolId).id}`,
      current: finding.eventId === focusEventId,
    });
  }
  return [...byStep.values()];
}
