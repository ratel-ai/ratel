import type { StepDraft } from "@/lib/ledger/types";
import type { SelfCorrection } from "@/lib/readings/trace-signals/self-corrections/detect";
import type { StoredCorrectionKind } from "@/lib/readings/trace-signals/self-corrections/kinds";
import type { PhraseCategory } from "@/lib/readings/trace-signals/self-corrections/phrases";
import type { PhraseCorrection } from "@/lib/readings/trace-signals/self-corrections/replies";

/**
 * One `trace_self_corrections` row per self-correction, minus its id and
 * project. Pure.
 *
 * `step_ordinal` is the step the row points at: the call before it when there
 * was one (so the failed call of a retry, a switch and a give-up is one
 * ordinal, and a failure is counted once however many rows it made), else the
 * step that shows it (a repeated search, the last step a person asked again
 * about). `occurred_at` is when it happened: the step that shows it, or the
 * reply a phrase is in.
 *
 * PRIVACY: a phrase row keeps its category, the canonical phrase and where it
 * sits in the captured reply, never the reply.
 */
export interface CorrectionRowDraft {
  turnId: string;
  kind: StoredCorrectionKind;
  stepOrdinal: number | null;
  toolId: string | null;
  toolOutcome: string | null;
  recovered: boolean | null;
  workflowId: string | null;
  phraseCategory: PhraseCategory | null;
  phrase: string | null;
  sourceEventId: string | null;
  matchStart: number | null;
  matchEnd: number | null;
  occurredAt: Date;
}

/** The turn a row belongs to, as much as a row needs. */
export interface RowTurn {
  id: string;
  endedAt: Date;
  workflowId: string | null;
}

/** A behaviour self-correction's row; `steps` are the turn's (or at least the one the event shows at). */
export function behaviourRow(
  turn: RowTurn,
  steps: readonly StepDraft[],
  event: SelfCorrection,
): CorrectionRowDraft {
  const shownAt = steps.find((step) => step.ordinal === event.ordinal);
  return {
    turnId: turn.id,
    kind: event.kind,
    stepOrdinal: event.toolOrdinal ?? event.ordinal,
    toolId: event.tool,
    toolOutcome: event.toolOutcome,
    recovered: event.recovered,
    workflowId: turn.workflowId,
    phraseCategory: null,
    phrase: null,
    sourceEventId: null,
    matchStart: null,
    matchEnd: null,
    occurredAt: shownAt?.occurredAt ?? turn.endedAt,
  };
}

/** A phrase's row: where it sits in the captured reply, and the call before the reply. */
export function phraseRow(turn: RowTurn, phrase: PhraseCorrection): CorrectionRowDraft {
  return {
    turnId: turn.id,
    kind: "phrase",
    stepOrdinal: phrase.toolOrdinal,
    toolId: phrase.tool,
    toolOutcome: phrase.toolOutcome,
    recovered: null,
    workflowId: turn.workflowId,
    phraseCategory: phrase.category,
    phrase: phrase.phrase,
    sourceEventId: phrase.sourceEventId,
    matchStart: phrase.start,
    matchEnd: phrase.end,
    occurredAt: phrase.occurredAt,
  };
}
