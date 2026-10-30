import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { events } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";

/** The model calls a project's agents made, newest first, from `events`. */

export type ModelCall = {
  id: string;
  at: Date;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  finishReason: string | null;
};

export type CallsCursor = { at: Date; id: string };

export type ModelCallsPage = {
  rows: ModelCall[];
  /** The cursor of the next page, or null on the last one. */
  next: string | null;
};

type CallsDb = Pick<ReturnType<typeof getDb>, "select">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<iso time>_<id>` of the last row seen; anything else reads as the first page. */
export function parseCallsCursor(value: string | null | undefined): CallsCursor | null {
  if (!value) return null;
  const split = value.lastIndexOf("_");
  const at = new Date(value.slice(0, split));
  const id = value.slice(split + 1);
  if (split < 0 || Number.isNaN(at.getTime()) || !UUID.test(id)) return null;
  return { at, id };
}

function serializeCursor({ at, id }: CallsCursor): string {
  return `${at.toISOString()}_${id}`;
}

export async function listModelCalls(
  projectId: string,
  { limit, after }: { limit: number; after?: CallsCursor | null },
  db: CallsDb = getDb(),
): Promise<ModelCallsPage> {
  // Calls without an occurrence time sort by when they arrived.
  const at = sql<Date>`coalesce(${events.occurredAt}, ${events.receivedAt})`;
  const rows = await db
    .select({
      id: events.id,
      at: at.mapWith(events.receivedAt),
      provider: events.provider,
      model: events.model,
      inputTokens: events.inputTokens,
      outputTokens: events.outputTokens,
      costUsd: events.costUsd,
      latencyMs: events.latencyMs,
      finishReason: events.finishReason,
    })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        after ? or(lt(at, after.at), and(eq(at, after.at), lt(events.id, after.id))) : undefined,
      ),
    )
    .orderBy(desc(at), desc(events.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).map((row) => ({
    ...row,
    costUsd: row.costUsd === null ? null : Number(row.costUsd),
  }));
  const last = page.at(-1);
  return { rows: page, next: rows.length > limit && last ? serializeCursor(last) : null };
}
