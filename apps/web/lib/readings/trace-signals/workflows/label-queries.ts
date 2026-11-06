import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { OTLP_MODEL_CALL } from "@/lib/ingest/otlp/derive-model-calls";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { jobs } from "@/lib/jobs/schema";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { traceSignalRuns, traceWorkflowLabels } from "@/lib/readings/trace-signals/schema";
import type { LabelTool } from "@/lib/readings/trace-signals/workflows/label";

/**
 * Reads and writes of the `label_workflows` job. Stored run JSON is untrusted:
 * malformed items are skipped. Asks are read only for a few example turns and
 * only when the customer captured them (the user message an SDK turn scope or
 * an OTel model call carried, else an SDK search query as a stand-in).
 */

export type LabelDb = Pick<ReturnType<typeof getDb>, "select" | "insert">;

export interface LabelableWorkflow {
  id: string;
  typicalOrder: string[];
  coreTools: string[];
  optionalTools: string[];
  /** Example turn ids, most useful first. */
  exampleTurnIds: string[];
}

const MAX_ITEMS = 64;
const OTLP_TURN_PREFIX = "otlp:";
const DECLARED_TURN_PREFIX = "declared:";
const HOUR_MS = 3_600_000;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];

function exampleIds(examples: unknown): string[] {
  if (!examples || typeof examples !== "object") return [];
  const groups = examples as Record<string, unknown>;
  const ids = ["recent", "slow", "failed"].flatMap((key) =>
    Array.isArray(groups[key])
      ? (groups[key] as unknown[]).flatMap((e) =>
          e && typeof e === "object" && typeof (e as { turnId?: unknown }).turnId === "string"
            ? [(e as { turnId: string }).turnId]
            : [],
        )
      : [],
  );
  return [...new Set(ids)];
}

/** The labelable part of each stored workflow item. */
export function parseLabelableWorkflows(items: unknown): LabelableWorkflow[] {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_ITEMS).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const typicalOrder = strings(record.typicalOrder);
    if (typeof record.id !== "string" || typicalOrder.length === 0) return [];
    const core = strings(record.coreTools);
    return [
      {
        id: record.id,
        typicalOrder,
        coreTools: core.length > 0 ? core : typicalOrder,
        optionalTools: strings(record.optionalTools),
        exampleTurnIds: exampleIds(record.examples),
      },
    ];
  });
}

export async function loadLatestWorkflows(
  projectId: string,
  db: LabelDb = getDb(),
): Promise<LabelableWorkflow[]> {
  const [row] = await db
    .select({ items: sql<unknown>`${traceSignalRuns.summary} -> 'workflows' -> 'items'` })
    .from(traceSignalRuns)
    .where(and(eq(traceSignalRuns.projectId, projectId), eq(traceSignalRuns.status, "completed")))
    .orderBy(desc(traceSignalRuns.createdAt))
    .limit(1);
  return parseLabelableWorkflows(row?.items ?? null);
}

export async function loadToolDocs(
  projectId: string,
  ids: readonly string[],
  db: LabelDb = getDb(),
): Promise<LabelTool[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: runtimeCatalogEntries.entryId,
      name: runtimeCatalogEntries.name,
      description: runtimeCatalogEntries.description,
    })
    .from(runtimeCatalogEntries)
    .where(
      and(
        eq(runtimeCatalogEntries.projectId, projectId),
        inArray(runtimeCatalogEntries.entryId, [...ids]),
      ),
    );
  return rows;
}

export async function loadLabelHashes(
  projectId: string,
  db: LabelDb = getDb(),
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: traceWorkflowLabels.workflowId, hash: traceWorkflowLabels.inputHash })
    .from(traceWorkflowLabels)
    .where(eq(traceWorkflowLabels.projectId, projectId));
  return new Map(rows.map((r) => [r.id, r.hash]));
}

/** Workflow names by id, for the page. */
export async function loadWorkflowLabels(
  projectId: string,
  db: Pick<LabelDb, "select"> = getDb(),
): Promise<Map<string, { name: string; description: string; icon: string | null }>> {
  const rows = await db
    .select({
      id: traceWorkflowLabels.workflowId,
      name: traceWorkflowLabels.name,
      description: traceWorkflowLabels.description,
      icon: traceWorkflowLabels.icon,
    })
    .from(traceWorkflowLabels)
    .where(eq(traceWorkflowLabels.projectId, projectId));
  return new Map(
    rows.map((r) => [r.id, { name: r.name, description: r.description, icon: r.icon }]),
  );
}

export interface SavedLabel {
  workflowId: string;
  inputHash: string;
  name: string;
  description: string;
  /** A WORKFLOW_ICONS key. */
  icon: string;
  model: string;
}

export async function saveLabel(
  projectId: string,
  label: SavedLabel,
  db: LabelDb = getDb(),
): Promise<void> {
  const now = new Date();
  await db
    .insert(traceWorkflowLabels)
    .values({ projectId, ...label, labelSource: "llm", createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [traceWorkflowLabels.projectId, traceWorkflowLabels.workflowId],
      set: {
        inputHash: label.inputHash,
        name: label.name,
        description: label.description,
        icon: label.icon,
        model: label.model,
        updatedAt: now,
      },
    });
}

/** Captured asks of the given turns, at most one per turn, in the order given. */
export async function loadTurnAsks(
  projectId: string,
  turnIds: readonly string[],
  db: LabelDb = getDb(),
): Promise<string[]> {
  const byTurn = await loadAsksByTurn(projectId, turnIds, db);
  return turnIds.flatMap((id) => {
    const ask = byTurn.get(id);
    return ask ? [ask] : [];
  });
}

/**
 * Where a run's ask came from, best first: the user's own message (the SDK's
 * `turn_start`), the first user message an OTel model call carried, or, as a
 * stand-in when neither was sent, the agent's first search query.
 */
export type AskSource = "user_message" | "prompt" | "search";

export interface TurnAsk {
  text: string;
  source: AskSource;
}

/** Each given turn's captured ask text, by turn id (see {@link loadAskSourcesByTurn}). */
export async function loadAsksByTurn(
  projectId: string,
  turnIds: readonly string[],
  db: LabelDb = getDb(),
): Promise<Map<string, string>> {
  const asks = await loadAskSourcesByTurn(projectId, turnIds, db);
  return new Map([...asks].map(([id, ask]) => [id, ask.text]));
}

/** Each given turn's captured ask and its source, by turn id. */
export async function loadAskSourcesByTurn(
  projectId: string,
  turnIds: readonly string[],
  db: LabelDb = getDb(),
): Promise<Map<string, TurnAsk>> {
  if (turnIds.length === 0) return new Map();
  const turns = await db
    .select({
      id: traceTurns.id,
      key: traceTurns.turnKey,
      sessionId: traceTurns.sessionId,
      startedAt: traceTurns.startedAt,
      endedAt: traceTurns.endedAt,
    })
    .from(traceTurns)
    .where(and(eq(traceTurns.projectId, projectId), inArray(traceTurns.id, [...turnIds])));
  const otlp = turns.filter((t) => t.key.startsWith(OTLP_TURN_PREFIX));
  const runtime = turns.filter((t) => !t.key.startsWith(OTLP_TURN_PREFIX));
  const declared = runtime.filter((t) => t.key.startsWith(DECLARED_TURN_PREFIX));
  // One after another: the caller may hand over one connection (a bounded read's transaction).
  const byTrace = await otlpAsks(projectId, otlp, db);
  const messages = await userMessages(projectId, declared, db);
  const queries = await runtimeAsks(
    runtime.map((t) => t.id),
    db,
  );
  const out = new Map<string, TurnAsk>();
  for (const turn of otlp) {
    const ask = byTrace.get(turn.key.slice(OTLP_TURN_PREFIX.length));
    if (ask) out.set(turn.id, { text: ask, source: "prompt" });
  }
  for (const [id, text] of queries) out.set(id, { text, source: "search" });
  for (const turn of declared) {
    const text = messages.get(
      messageKey(turn.sessionId, turn.key.slice(DECLARED_TURN_PREFIX.length)),
    );
    if (text) out.set(turn.id, { text, source: "user_message" });
  }
  return out;
}

const messageKey = (sessionId: string, turnId: string): string => `${sessionId}\u0000${turnId}`;

/** The user messages SDK turn scopes sent (`turn_start`), by session and turn id. */
async function userMessages(
  projectId: string,
  turns: readonly { key: string; sessionId: string; startedAt: Date; endedAt: Date | null }[],
  db: LabelDb,
): Promise<Map<string, string>> {
  if (turns.length === 0) return new Map();
  const ids = [...new Set(turns.map((t) => t.key.slice(DECLARED_TURN_PREFIX.length)))];
  const sessions = [...new Set(turns.map((t) => t.sessionId))];
  const from = new Date(Math.min(...turns.map((t) => t.startedAt.getTime())) - HOUR_MS);
  const to = new Date(
    Math.max(...turns.map((t) => (t.endedAt ?? t.startedAt).getTime())) + HOUR_MS,
  );
  const at = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
  const rows = await db
    .select({
      sessionId: traceEvents.sessionId,
      turnId: sql<string | null>`${traceEvents.payload} ->> 'turn_id'`,
      message: sql<string | null>`${traceEvents.payload} ->> 'user_message'`,
    })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.type, "turn_start"),
        sql`${at} >= ${from} and ${at} <= ${to}`,
        inArray(traceEvents.sessionId, sessions),
        inArray(sql`${traceEvents.payload} ->> 'turn_id'`, ids),
      ),
    )
    .orderBy(asc(at));
  const out = new Map<string, string>();
  for (const row of rows) {
    const text = row.message?.trim();
    if (!row.sessionId || !row.turnId || !text) continue;
    const key = messageKey(row.sessionId, row.turnId);
    if (!out.has(key)) out.set(key, text);
  }
  return out;
}

async function otlpAsks(
  projectId: string,
  turns: readonly { key: string; startedAt: Date; endedAt: Date | null }[],
  db: LabelDb,
): Promise<Map<string, string>> {
  if (turns.length === 0) return new Map();
  const traceIds = turns.map((t) => t.key.slice(OTLP_TURN_PREFIX.length));
  const from = new Date(Math.min(...turns.map((t) => t.startedAt.getTime())) - HOUR_MS);
  const to = new Date(
    Math.max(...turns.map((t) => (t.endedAt ?? t.startedAt).getTime())) + HOUR_MS,
  );
  const at = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
  const rows = await db
    .select({
      traceId: traceEvents.traceId,
      prompt: sql<string | null>`${traceEvents.payload} ->> 'prompt'`,
    })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        // Model calls carry the ask; so do the tool rows of imported runs, which have no model call.
        inArray(traceEvents.type, [OTLP_MODEL_CALL, "invoke_end", "invoke_error"]),
        sql`${traceEvents.payload} ? 'prompt'`,
        sql`${at} >= ${from} and ${at} <= ${to}`,
        inArray(traceEvents.traceId, traceIds),
      ),
    )
    .orderBy(asc(at));
  const out = new Map<string, string>();
  for (const row of rows)
    if (row.traceId && row.prompt && !out.has(row.traceId)) out.set(row.traceId, row.prompt);
  return out;
}

async function runtimeAsks(turnIds: readonly string[], db: LabelDb): Promise<Map<string, string>> {
  if (turnIds.length === 0) return new Map();
  const rows = await db
    .select({ turnId: traceTurnSteps.turnId, query: traceEvents.query })
    .from(traceTurnSteps)
    .innerJoin(traceEvents, eq(traceEvents.id, traceTurnSteps.traceEventId))
    .where(and(inArray(traceTurnSteps.turnId, [...turnIds]), eq(traceTurnSteps.kind, "search")))
    .orderBy(asc(traceTurnSteps.ordinal));
  const out = new Map<string, string>();
  for (const row of rows) if (row.query && !out.has(row.turnId)) out.set(row.turnId, row.query);
  return out;
}

/** Queue one `label_workflows` job for the project; coalesced while one is queued. */
export async function enqueueLabelWorkflowsJob(
  projectId: string,
  db: Pick<LabelDb, "insert"> = getDb(),
): Promise<{ id: string } | null> {
  const rows = await db
    .insert(jobs)
    .values({ projectId, kind: "label_workflows", status: "queued", payload: {} })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0] ?? null;
}
