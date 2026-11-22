import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import type { StepDraft } from "@/lib/ledger/types";
import type { getDb } from "@/lib/platform/db/client";
import { taskSegments } from "@/lib/readings/trace-signals/schema";
import { placeRuns } from "../workflows/place";
import type { WorkflowBasis } from "../workflows/run-basis";
import type { WorkflowCore } from "../workflows/types";
import { mergePieces, type TaskSegment } from "./merge";
import { cutTurn } from "./pieces";

export interface SegmentPlacement {
  tasks: readonly WorkflowCore[];
  weights: Readonly<Record<string, number>>;
  basis: WorkflowBasis;
}

/** Replace complete affected sessions and their legacy turn pointers in one transaction. */
export async function writeTaskSegments(
  projectId: string,
  window: { start: Date; end: Date },
  options: SegmentPlacement,
  db: Pick<ReturnType<typeof getDb>, "transaction">,
) {
  return db.transaction(async (tx) => {
    const affected = await tx
      .selectDistinct({ sessionId: traceTurns.sessionId })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, projectId),
          eq(traceTurns.status, "closed"),
          gte(traceTurns.endedAt, window.start),
          lt(traceTurns.endedAt, window.end),
        ),
      );
    let placed = 0,
      set = 0,
      cleared = 0;
    for (const { sessionId } of affected.sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
      const turns = await tx
        .select()
        .from(traceTurns)
        .where(
          and(
            eq(traceTurns.projectId, projectId),
            eq(traceTurns.sessionId, sessionId),
            eq(traceTurns.status, "closed"),
          ),
        )
        .orderBy(asc(traceTurns.startedAt), asc(traceTurns.id))
        .for("update");
      const steps = await tx
        .select()
        .from(traceTurnSteps)
        .where(
          and(
            eq(traceTurnSteps.projectId, projectId),
            inArray(
              traceTurnSteps.turnId,
              turns.map((t) => t.id),
            ),
          ),
        )
        .orderBy(asc(traceTurnSteps.ordinal));
      const byTurn = new Map<string, StepDraft[]>();
      for (const step of steps) {
        const list = byTurn.get(step.turnId) ?? [];
        list.push(step as unknown as StepDraft);
        byTurn.set(step.turnId, list);
      }
      const pieces = turns.flatMap((turn) =>
        cutTurn({ ...turn, steps: byTurn.get(turn.id) ?? [] }),
      );
      const sources = new Map(turns.map((t) => [t.id, t.turnSource]));
      const placement = placeRuns(
        pieces.map((p) => ({
          ...p,
          turnSource: sources.get(p.turnId) as "otlp" | "declared" | "inferred",
        })),
        options.tasks,
        options,
      );
      const segments = mergePieces(pieces, placement);
      await tx
        .delete(taskSegments)
        .where(and(eq(taskSegments.projectId, projectId), eq(taskSegments.sessionId, sessionId)));
      if (segments.length)
        await tx.insert(taskSegments).values(
          segments.map((segment) => ({
            ...segment,
            projectId,
            id: segmentId(projectId, segment),
          })),
        );
      const first = new Map<string, string>();
      for (const segment of segments)
        for (const turnId of segment.turnIds)
          if (!first.has(turnId)) first.set(turnId, segment.workflowId);
      for (const turn of turns) {
        const workflowId = first.get(turn.id) ?? null;
        if (workflowId) placed++;
        if (turn.workflowId === workflowId) continue;
        await tx
          .update(traceTurns)
          .set({ workflowId })
          .where(and(eq(traceTurns.projectId, projectId), eq(traceTurns.id, turn.id)));
        if (workflowId) set++;
        else cleared++;
      }
    }
    return { placed, set, cleared };
  });
}

function segmentId(projectId: string, segment: TaskSegment): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        projectId,
        segment.sessionId,
        segment.workflowId,
        segment.startTurnId,
        segment.startOrdinal,
        segment.endTurnId,
        segment.endOrdinal,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}
