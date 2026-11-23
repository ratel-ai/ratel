import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import {
  HALLUCINATION_RULE_VERSION,
  type HallucinationEvidence,
  type HallucinationKind,
} from "@/lib/readings/trace-signals/hallucinations/kinds";
import { traceHallucinations, traceTurnOutcomes } from "@/lib/readings/trace-signals/schema";

/**
 * The hallucination reading's queries: what a page of calls carries beyond
 * its steps (the error text, the tool the agent asked for, a result that said
 * no such tool exists), and the replace of a window's findings.
 */

export type HallucinationsDb = Pick<ReturnType<typeof getDb>, "select" | "transaction">;

const ID_CHUNK = 500;
const INSERT_CHUNK = 500;

function chunks<T>(items: readonly T[], size: number = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** What the events of a page's calls say, by `trace_events` id. Text is read here and never stored. */
/**
 * The window's turns whose cause a model read as a false success from the
 * person's next message (`outcomes/questions.ts`), with each one's end. Ids
 * and times only.
 */
export async function loadFalseSuccessTurns(
  projectId: string,
  range: { from: Date; to: Date },
  db: Pick<HallucinationsDb, "select"> = getDb(),
): Promise<ReadonlyMap<string, Date>> {
  const rows = await db
    .select({ turnId: traceTurnOutcomes.turnId, endedAt: traceTurnOutcomes.endedAt })
    .from(traceTurnOutcomes)
    .where(
      and(
        eq(traceTurnOutcomes.projectId, projectId),
        eq(traceTurnOutcomes.cause, "false_success"),
        gte(traceTurnOutcomes.endedAt, range.from),
        lt(traceTurnOutcomes.endedAt, range.to),
      ),
    );
  return new Map(rows.map((row) => [row.turnId, row.endedAt]));
}

export interface CallFacts {
  /** Error text: the column ingest fills, else the payload's `error` (rows a replay loaded). */
  errors: Map<string, string>;
  /** The tool id the agent asked for, where the SDK sent one (it does only when it differs from the tool that ran). */
  requested: Map<string, string>;
  /** Calls whose result said no such tool exists (`lib/otlp/derive-tools.ts`). */
  noSuchTool: Set<string>;
}

/** The facts of these events. An event that is pruned, or says none of this, is absent. */
export async function loadCallFacts(
  projectId: string,
  eventIds: readonly string[],
  db: Pick<HallucinationsDb, "select"> = getDb(),
): Promise<CallFacts> {
  const facts: CallFacts = { errors: new Map(), requested: new Map(), noSuchTool: new Set() };
  for (const ids of chunks([...new Set(eventIds)])) {
    const rows = await db
      .select({
        id: traceEvents.id,
        error: sql<
          string | null
        >`coalesce(${traceEvents.errorMessage}, ${traceEvents.payload} ->> 'error')`,
        requested: sql<string | null>`${traceEvents.payload} ->> 'requested_tool_id'`,
        noSuchTool: sql<
          boolean | null
        >`(${traceEvents.payload} ->> 'result_no_such_tool') = 'true'`,
      })
      .from(traceEvents)
      .where(
        and(
          eq(traceEvents.projectId, projectId),
          inArray(traceEvents.id, ids),
          sql`(${traceEvents.errorMessage} is not null or ${traceEvents.payload} ?| array['error', 'requested_tool_id', 'result_no_such_tool'])`,
        ),
      );
    for (const row of rows) {
      if (row.error) facts.errors.set(row.id, row.error);
      if (row.requested) facts.requested.set(row.id, row.requested);
      if (row.noSuchTool) facts.noSuchTool.add(row.id);
    }
  }
  return facts;
}

export interface HallucinationRowDraft {
  turnId: string;
  stepOrdinal: number;
  kind: HallucinationKind;
  toolId: string;
  requestedToolId: string | null;
  evidence: HallucinationEvidence;
  repeats: number;
  worked: boolean;
  occurredAt: Date;
}

/**
 * Replace the findings of the closed turns ending in `range` with `rows`, in
 * one transaction, so a page never reads a half-written window. Rows of older
 * turns stay: they are the history.
 */
export async function replaceHallucinations(
  projectId: string,
  range: { from: Date; to: Date },
  rows: readonly HallucinationRowDraft[],
  db: HallucinationsDb = getDb(),
): Promise<number> {
  return db.transaction(async (tx) => {
    const window = tx
      .select({ id: traceTurns.id })
      .from(traceTurns)
      .where(
        and(
          eq(traceTurns.projectId, projectId),
          eq(traceTurns.status, "closed"),
          gte(traceTurns.endedAt, range.from),
          lt(traceTurns.endedAt, range.to),
        ),
      );
    await tx
      .delete(traceHallucinations)
      .where(
        and(
          eq(traceHallucinations.projectId, projectId),
          inArray(traceHallucinations.turnId, window),
        ),
      );
    for (const chunk of chunks(rows, INSERT_CHUNK)) {
      await tx
        .insert(traceHallucinations)
        .values(
          chunk.map((row) => ({ ...row, projectId, ruleVersion: HALLUCINATION_RULE_VERSION })),
        );
    }
    return rows.length;
  });
}
