import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";

/**
 * The run behind an insight's sampled turns, shared by RC-45's `sourceOf` and
 * the MCP loop's insight reads so the console and MCP name the same trace.
 */

type TurnTracesDb = Pick<ReturnType<typeof getDb>, "select">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many sampled turns are tried for a run before an insight falls back to its metric. */
export const TURNS_TRIED = 5;

/**
 * The turn ids an insight's evidence samples, newest first, that are tried
 * for a run: only well-formed ids count, then the first `TURNS_TRIED` of them.
 */
export function sampledTurnIds(evidence: unknown): string[] {
  const raw = (evidence as { turnIds?: unknown } | null | undefined)?.turnIds;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((id): id is string => typeof id === "string" && UUID.test(id))
    .slice(0, TURNS_TRIED);
}

/**
 * The run id behind each turn, in one batch: an OTLP turn (`turn_key =
 * "otlp:<trace id>"`) is its own trace; a runtime (SDK) turn has none of its
 * own, so its events name theirs. Turns with no run, malformed ids and turns
 * of another project are left out.
 */
export async function traceIdsForTurns(
  projectId: string,
  turnIds: readonly string[],
  db: TurnTracesDb = getDb(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(turnIds.filter((id) => UUID.test(id)))];
  if (ids.length === 0 || !UUID.test(projectId)) return out;
  const turns = await db
    .select({ id: traceTurns.id, turnKey: traceTurns.turnKey })
    .from(traceTurns)
    .where(and(eq(traceTurns.projectId, projectId), inArray(traceTurns.id, ids)));
  for (const turn of turns) {
    if (turn.turnKey.startsWith("otlp:")) out.set(turn.id, turn.turnKey.slice("otlp:".length));
  }
  const rest = turns.filter((turn) => !out.has(turn.id)).map((turn) => turn.id);
  if (rest.length > 0) {
    const steps = await db
      .select({ turnId: traceTurnSteps.turnId, traceId: traceEvents.traceId })
      .from(traceTurnSteps)
      .innerJoin(traceEvents, eq(traceEvents.id, traceTurnSteps.traceEventId))
      .where(
        and(
          eq(traceTurnSteps.projectId, projectId),
          inArray(traceTurnSteps.turnId, rest),
          eq(traceEvents.projectId, projectId),
          isNotNull(traceEvents.traceId),
        ),
      );
    for (const step of steps)
      if (step.traceId && !out.has(step.turnId)) out.set(step.turnId, step.traceId);
  }
  return out;
}

/** The run of the first turn, in the order given, that has one; null when none does. */
export function firstTraceOf(
  turnIds: readonly string[],
  traces: ReadonlyMap<string, string>,
): string | null {
  for (const id of turnIds) {
    const traceId = traces.get(id);
    if (traceId) return traceId;
  }
  return null;
}
