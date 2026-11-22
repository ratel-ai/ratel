import { and, asc, desc, eq, gt, gte, inArray, isNotNull } from "drizzle-orm";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import type { CarriedRow } from "@/lib/readings/labelling/carry";
import { traceWorkflowInsights, traceWorkflowVerdicts } from "@/lib/readings/trace-signals/schema";
import {
  type AskGroup,
  normalizeAsk,
  preferUserAsks,
  type WorkflowInsights,
} from "@/lib/readings/trace-signals/workflows/decide";
import {
  type LabelDb,
  loadAskSourcesByTurn,
  type TurnAsk,
} from "@/lib/readings/trace-signals/workflows/label-queries";
import type { WorkflowStep } from "@/lib/readings/trace-signals/workflows/types";
import { stepsUnit } from "@/lib/readings/trace-signals/workflows/units";

/**
 * Reads and writes of the decision step. Asks come only from what the customer
 * captured; verdicts are cached by hashes, never by text.
 */

const RECENT_TURNS = 1_000;

/**
 * Distinct captured asks of the project's most recent closed turns, newest
 * first. The users' own messages win: once enough runs carry one, the search
 * stand-ins are left out (`preferUserAsks`).
 */
export async function loadRecentAskGroups(
  projectId: string,
  since: Date,
  maxGroups: number,
  db: LabelDb = getDb(),
): Promise<AskGroup[]> {
  const turns = await db
    .select({ id: traceTurns.id, errors: traceTurns.errorCount, invokes: traceTurns.invokeCount })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.status, "closed"),
        gte(traceTurns.endedAt, since),
      ),
    )
    .orderBy(desc(traceTurns.endedAt))
    .limit(RECENT_TURNS);
  const captured = await loadTurnAsksById(
    projectId,
    turns.map((t) => t.id),
    db,
  );
  const sourced = turns.flatMap((turn) => {
    const ask = captured.get(turn.id);
    return ask
      ? [
          {
            turn,
            text: ask.text,
            source: ask.source === "search" ? ("search" as const) : ("user" as const),
          },
        ]
      : [];
  });
  const kept = preferUserAsks(sourced);
  const tools = await loadTurnTools(
    kept.map((k) => k.turn.id),
    db,
  );
  const groups = new Map<string, AskGroup>();
  for (const { turn, text, source } of kept) {
    const key = normalizeAsk(text);
    const group = groups.get(key) ?? { ask: text, turns: [], source };
    groups.set(key, {
      ...group,
      turns: [...group.turns, { ...turn, tools: tools.get(turn.id) ?? [] }],
    });
  }
  return [...groups.values()].slice(0, maxGroups);
}

/** Each turn's distinct step tokens in first-call order, as mining reads them (`units.ts`). */
export async function loadTurnTools(
  turnIds: readonly string[],
  db: LabelDb,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const CHUNK = 500;
  for (let i = 0; i < turnIds.length; i += CHUNK) {
    const rows = await db
      .select()
      .from(traceTurnSteps)
      .where(inArray(traceTurnSteps.turnId, turnIds.slice(i, i + CHUNK)))
      .orderBy(asc(traceTurnSteps.ordinal));
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) grouped.set(row.turnId, [...(grouped.get(row.turnId) ?? []), row]);
    for (const [id, steps] of grouped) {
      const tokens = stepsUnit(id, steps as WorkflowStep[]).path;
      if (tokens.length) out.set(id, [...tokens]);
    }
  }
  return out;
}

/** Asks by turn id, reusing the label step's per-turn reads in chunks. */
async function loadTurnAsksById(
  projectId: string,
  turnIds: readonly string[],
  db: LabelDb,
): Promise<Map<string, TurnAsk>> {
  const out = new Map<string, TurnAsk>();
  const CHUNK = 200;
  for (let i = 0; i < turnIds.length; i += CHUNK) {
    const chunk = turnIds.slice(i, i + CHUNK);
    const asks = await loadAskSourcesByTurn(projectId, chunk, db);
    for (const [id, ask] of asks) out.set(id, ask);
  }
  return out;
}

export async function loadVerdicts(
  projectId: string,
  optionsHash: string,
  promptHashes: readonly string[],
  db: LabelDb = getDb(),
): Promise<Map<string, { entryId: string }>> {
  if (promptHashes.length === 0) return new Map();
  const rows = await db
    .select({
      hash: traceWorkflowVerdicts.promptHash,
      verdict: traceWorkflowVerdicts.verdict,
      workflowId: traceWorkflowVerdicts.workflowId,
    })
    .from(traceWorkflowVerdicts)
    .where(
      and(
        eq(traceWorkflowVerdicts.projectId, projectId),
        eq(traceWorkflowVerdicts.optionsHash, optionsHash),
        inArray(traceWorkflowVerdicts.promptHash, [...promptHashes]),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.hash,
      {
        entryId:
          r.verdict === "none" ? "none" : r.verdict === "workflow" ? (r.workflowId ?? "") : "",
      },
    ]),
  );
}

export interface VerdictRow {
  promptHash: string;
  verdict: "workflow" | "none" | "unclear";
  workflowId: string | null;
  confidence: number | null;
  /** The chosen option's print (`lib/labelling/carry.ts`), for a decided verdict. */
  optionPrint?: string | null;
}

/**
 * The newest stored decision for each of these asks under ANY option list
 * that names an option with its print: what `decideWithCarry` may carry to a
 * new list. One row per ask (distinct on the prompt), read on the primary
 * key's (project, prompt) prefix.
 */
export async function loadCarriedVerdicts(
  projectId: string,
  promptHashes: readonly string[],
  db: Pick<ReturnType<typeof getDb>, "selectDistinctOn"> = getDb(),
): Promise<CarriedRow[]> {
  if (promptHashes.length === 0) return [];
  const out: CarriedRow[] = [];
  const CHUNK = 500;
  for (let i = 0; i < promptHashes.length; i += CHUNK) {
    const rows = await db
      .selectDistinctOn([traceWorkflowVerdicts.promptHash], {
        hash: traceWorkflowVerdicts.promptHash,
        workflowId: traceWorkflowVerdicts.workflowId,
        print: traceWorkflowVerdicts.optionPrint,
      })
      .from(traceWorkflowVerdicts)
      .where(
        and(
          eq(traceWorkflowVerdicts.projectId, projectId),
          inArray(traceWorkflowVerdicts.promptHash, promptHashes.slice(i, i + CHUNK)),
          eq(traceWorkflowVerdicts.verdict, "workflow"),
          isNotNull(traceWorkflowVerdicts.optionPrint),
        ),
      )
      .orderBy(traceWorkflowVerdicts.promptHash, desc(traceWorkflowVerdicts.createdAt));
    for (const row of rows) {
      if (row.workflowId && row.print)
        out.push({ promptHash: row.hash, optionId: row.workflowId, optionPrint: row.print });
    }
  }
  return out;
}

export async function saveVerdicts(
  projectId: string,
  optionsHash: string,
  model: string,
  rows: readonly VerdictRow[],
  db: LabelDb = getDb(),
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(traceWorkflowVerdicts)
    .values(
      rows.map((r) => ({
        projectId,
        optionsHash,
        model,
        ...r,
        optionPrint: r.optionPrint ?? null,
      })),
    )
    .onConflictDoNothing();
}

export async function saveInsights(
  projectId: string,
  data: WorkflowInsights,
  model: string,
  db: LabelDb = getDb(),
): Promise<void> {
  const now = new Date();
  await db
    .insert(traceWorkflowInsights)
    .values({ projectId, data: data as unknown as Record<string, unknown>, model, computedAt: now })
    .onConflictDoUpdate({
      target: traceWorkflowInsights.projectId,
      set: { data: data as unknown as Record<string, unknown>, model, computedAt: now },
    });
}

/** The latest insights, for the page; null when none were computed. */
export async function loadWorkflowInsights(
  projectId: string,
  db: Pick<LabelDb, "select"> = getDb(),
): Promise<{ data: WorkflowInsights; computedAt: Date } | null> {
  const [row] = await db
    .select({ data: traceWorkflowInsights.data, computedAt: traceWorkflowInsights.computedAt })
    .from(traceWorkflowInsights)
    .where(
      and(
        eq(traceWorkflowInsights.projectId, projectId),
        gt(traceWorkflowInsights.computedAt, new Date(0)),
      ),
    )
    .limit(1);
  const data = row?.data as Partial<WorkflowInsights> | undefined;
  // Older rows counted early stops differently; they read as none until the next job rewrites them.
  if (
    !row ||
    !data ||
    data.version !== 3 ||
    typeof data.placed !== "object" ||
    !Array.isArray(data.unserved)
  )
    return null;
  return { data: data as WorkflowInsights, computedAt: row.computedAt };
}
