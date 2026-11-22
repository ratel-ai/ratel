import type { TaskPiece } from "./pieces";

export interface TaskSegment {
  sessionId: string;
  workflowId: string;
  startTurnId: string;
  startOrdinal: number;
  endTurnId: string;
  endOrdinal: number;
  startedAt: Date;
  endedAt: Date;
  turnIds: string[];
  pieceCount: number;
}

/** Merge adjacent placed pieces within each session. An unplaced piece ends a segment. */
export function mergePieces(
  pieces: readonly TaskPiece[],
  placement: ReadonlyMap<string, string | null>,
): TaskSegment[] {
  const ordered = [...pieces].sort(
    (a, b) =>
      a.sessionId.localeCompare(b.sessionId) ||
      a.startedAt.getTime() - b.startedAt.getTime() ||
      a.turnId.localeCompare(b.turnId) ||
      a.startOrdinal - b.startOrdinal,
  );
  const out: TaskSegment[] = [];
  let active: TaskSegment | undefined;
  for (const piece of ordered) {
    const task = placement.get(piece.id);
    if (!task) {
      active = undefined;
      continue;
    }
    if (active?.sessionId === piece.sessionId && active.workflowId === task) {
      active.endTurnId = piece.turnId;
      active.endOrdinal = piece.endOrdinal;
      active.endedAt = piece.endedAt;
      active.pieceCount += 1;
      if (!active.turnIds.includes(piece.turnId)) active.turnIds.push(piece.turnId);
    } else {
      active = {
        sessionId: piece.sessionId,
        workflowId: task,
        startTurnId: piece.turnId,
        startOrdinal: piece.startOrdinal,
        endTurnId: piece.turnId,
        endOrdinal: piece.endOrdinal,
        startedAt: piece.startedAt,
        endedAt: piece.endedAt,
        turnIds: [piece.turnId],
        pieceCount: 1,
      };
      out.push(active);
    }
  }
  return out;
}
