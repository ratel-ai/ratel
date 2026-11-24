import { and, eq, sql } from "drizzle-orm";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import type { TracesIngestDiagnostics } from "@/lib/synthesis/traces/queries";

/** The Panel `?peek=context` opens. */
export const CONTEXT_PEEK = "context";

export interface OverviewProject {
  id: string;
  name: string;
  slug: string;
  isDemo: boolean;
}

/** The SDK events that count as a sign of life: a search, a tool call, a skill run. */
const SDK_TYPES = ["search", "invoke_start", "skill_invoke"] as const;

/**
 * The newest SDK search, tool call or skill run, one index lookup per kind.
 * One after another: `db` is a single bounded transaction, and a connection
 * runs one query at a time (concurrent queries on it are deprecated in pg).
 */
export async function latestSdkEventAt(
  projectId: string,
  db: BoundReadDb = getDb(),
): Promise<Date | null> {
  const at = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
  let latest: Date | null = null;
  for (const type of SDK_TYPES) {
    const [row] = await db
      .select({ latest: sql<string | Date | null>`max(${at})` })
      .from(traceEvents)
      .where(and(eq(traceEvents.projectId, projectId), eq(traceEvents.type, type)));
    latest = newest(latest, row?.latest ? new Date(row.latest) : null);
  }
  return latest;
}

export function newest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

export function latestEventAt({
  latestEventAt: event,
  latestSpanAt: span,
}: TracesIngestDiagnostics): Date | null {
  if (event === null) return span;
  if (span === null) return event;
  return event > span ? event : span;
}
