import { and, desc, eq, gt, gte, inArray } from "drizzle-orm";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
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

/** The distinct tools each turn called. */
async function loadTurnTools(
  turnIds: readonly string[],
  db: LabelDb,
): Promise<Map<string, string[]>> {
  const out = new Map<string, Set<string>>();
  const CHUNK = 500;
  for (let i = 0; i < turnIds.length; i += CHUNK) {
    const rows = await db
      .select({ turnId: traceTurnSteps.turnId, tool: traceTurnSteps.targetId })
      .from(traceTurnSteps)
      .where(
        and(
          inArray(traceTurnSteps.turnId, turnIds.slice(i, i + CHUNK)),
          eq(traceTurnSteps.kind, "invoke"),
        ),
      );
    for (const row of rows) {
      if (!row.tool) continue;
      out.set(row.turnId, (out.get(row.turnId) ?? new Set()).add(row.tool));
    }
  }
  return new Map([...out].map(([id, set]) => [id, [...set]]));
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
    .values(rows.map((r) => ({ projectId, optionsHash, model, ...r })))
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
