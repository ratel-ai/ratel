import { and, eq, inArray, isNull } from "drizzle-orm";
import { otelSpans } from "@/lib/ingest/otlp/schema";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";
import { loadAskSourcesByTurn } from "@/lib/readings/trace-signals/workflows/label-queries";
import { type EvalDb, traceIdsOf } from "@/lib/views/eval-gate/runs";

/**
 * RC-853: a run that works on a project of another organization cannot become
 * an eval. Ratel Cloud's own backend jobs are runs in our own project, and
 * their asks named the customer project they worked on (`cluster_intents for
 * project <uuid>`). An eval recorded from such a run copied the customer's
 * asks into an eval row, and eval rows do not expire (raw telemetry does).
 *
 * The rule is general, not tied to our organization: a run is foreign when
 * its ask, or an attribute of its root span, names the id of a project whose
 * organization is not the eval project's organization. Ids that name no
 * project, and projects of the same organization, are fine.
 */

export const FOREIGN_PROJECT_ERROR =
  "This run works on a project of another organization, so it cannot become an eval here.";

/** A run to check; `ask` when the caller has read it already. */
export interface RunToCheck {
  turnId: string;
  ask?: string;
}

const OTLP_TURN_PREFIX = "otlp:";
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The ids of the projects of other organizations that the run's ask or root span names. Empty: the run can become an eval. */
export async function foreignProjectsOfRun(
  projectId: string,
  turnId: string,
  db: EvalDb = getDb(),
): Promise<string[]> {
  return (await foreignProjectsOfRuns(projectId, [{ turnId }], db)).get(turnId) ?? [];
}

/** {@link foreignProjectsOfRun} for many runs at once: only the foreign runs are in the map. */
export async function foreignProjectsOfRuns(
  projectId: string,
  runs: readonly RunToCheck[],
  db: EvalDb = getDb(),
): Promise<Map<string, string[]>> {
  if (runs.length === 0) return new Map();
  const unread = runs.filter((run) => run.ask === undefined).map((run) => run.turnId);
  const asks = unread.length > 0 ? await loadAskSourcesByTurn(projectId, unread, db) : new Map();
  const spans = await rootSpanAttributes(
    projectId,
    runs.map((run) => run.turnId),
    db,
  );
  const named = new Map(
    runs.map((run) => {
      const ids = new Set([
        ...uuidsIn(run.ask ?? asks.get(run.turnId)?.text ?? ""),
        ...uuidsIn(JSON.stringify(spans.get(run.turnId) ?? [])),
      ]);
      ids.delete(projectId);
      return [run.turnId, ids] as const;
    }),
  );
  const all = [...new Set([...named.values()].flatMap((ids) => [...ids]))];
  if (all.length === 0) return new Map();
  const [own] = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const rows = await db
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .where(inArray(projects.id, all));
  const foreign = new Set(
    rows.filter((row) => row.organizationId !== own?.organizationId).map((row) => row.id),
  );
  const out = new Map<string, string[]>();
  for (const [turnId, ids] of named) {
    const hits = [...ids].filter((id) => foreign.has(id)).sort();
    if (hits.length > 0) out.set(turnId, hits);
  }
  return out;
}

/** The attributes of each run's root spans, when the run's traces are kept. */
async function rootSpanAttributes(
  projectId: string,
  turnIds: readonly string[],
  db: EvalDb,
): Promise<Map<string, Record<string, unknown>[]>> {
  const turnsByTrace = new Map<string, Set<string>>();
  const link = (traceId: string, turnId: string) =>
    turnsByTrace.set(traceId, (turnsByTrace.get(traceId) ?? new Set()).add(turnId));
  for (const [turnId, traceId] of await traceIdsOf(projectId, turnIds, db)) link(traceId, turnId);
  const turns = await db
    .select({ id: traceTurns.id, key: traceTurns.turnKey })
    .from(traceTurns)
    .where(and(eq(traceTurns.projectId, projectId), inArray(traceTurns.id, [...turnIds])));
  for (const turn of turns)
    if (turn.key.startsWith(OTLP_TURN_PREFIX))
      link(turn.key.slice(OTLP_TURN_PREFIX.length), turn.id);
  const out = new Map<string, Record<string, unknown>[]>();
  if (turnsByTrace.size === 0) return out;
  const rows = await db
    .select({ traceId: otelSpans.traceId, attributes: otelSpans.attributes })
    .from(otelSpans)
    .where(
      and(
        eq(otelSpans.projectId, projectId),
        inArray(otelSpans.traceId, [...turnsByTrace.keys()]),
        isNull(otelSpans.parentSpanId),
      ),
    );
  for (const row of rows) {
    for (const turnId of turnsByTrace.get(row.traceId) ?? [])
      out.set(turnId, [...(out.get(turnId) ?? []), row.attributes]);
  }
  return out;
}

function uuidsIn(text: string): string[] {
  return [...text.matchAll(UUID_IN_TEXT)].map((match) => match[0].toLowerCase());
}
