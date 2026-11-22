import type { StepDraft } from "@/lib/ledger/types";

export interface PieceTurn {
  id: string;
  sessionId: string;
  startedAt: Date;
  endedAt: Date;
  steps: readonly StepDraft[];
}

export interface TaskPiece {
  id: string;
  turnId: string;
  sessionId: string;
  startOrdinal: number;
  endOrdinal: number;
  startedAt: Date;
  endedAt: Date;
  steps: readonly StepDraft[];
}

/** Cut at subsequent user messages. Keep setup steps with the first message. */
export function cutTurn(turn: PieceTurn): TaskPiece[] {
  const steps = [...turn.steps].sort((a, b) => a.ordinal - b.ordinal);
  if (steps.length === 0) return [];
  const firstMessage = steps.findIndex((step) => step.kind === "user_message");
  const starts = [
    0,
    ...steps.flatMap((step, i) => (i > firstMessage && step.kind === "user_message" ? [i] : [])),
  ];
  return starts.map((start, i) => {
    const kept = steps.slice(start, starts[i + 1] ?? steps.length);
    const first = kept[0]!;
    const last = kept[kept.length - 1]!;
    return {
      id: `${turn.id}:${first.ordinal}`,
      turnId: turn.id,
      sessionId: turn.sessionId,
      startOrdinal: first.ordinal,
      endOrdinal: last.ordinal,
      startedAt: i === 0 ? turn.startedAt : first.occurredAt,
      endedAt:
        i === starts.length - 1
          ? turn.endedAt
          : new Date(
              Math.max(
                last.occurredAt.getTime(),
                last.endOccurredAt?.getTime() ?? last.occurredAt.getTime() + (last.tookMs ?? 0),
              ),
            ),
      steps: kept,
    };
  });
}
