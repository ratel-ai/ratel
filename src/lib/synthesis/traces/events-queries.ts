import { and, desc, eq, gte, isNull, lt, or } from "drizzle-orm";
import { otelLogs } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import { containsText } from "./query-text";

export type EventQueriesDb = Pick<ReturnType<typeof getDb>, "select">;

export interface EventCursor {
  occurredAt: Date;
  id: string;
}

export interface ListProjectEventsOptions {
  since?: Date;
  until?: Date;
  eventName?: string;
  experiment?: string;
  tracelessOnly?: boolean;
  cursor?: EventCursor;
  limit?: number;
}

export interface ProjectEventSummary {
  id: string;
  occurredAt: Date;
  eventName: string;
  traceId: string | null;
  spanId: string | null;
  serviceName: string | null;
  experimentName: string | null;
  experimentArm: string | null;
  experimentRole: string | null;
  body: unknown;
  experimentAttrs: Record<string, unknown>;
  attributes: Record<string, unknown>;
  attrsTruncated: boolean;
}

export interface ProjectEventPage {
  items: ProjectEventSummary[];
  hasMore: boolean;
  nextCursor: EventCursor | null;
}

export const DEFAULT_EVENT_PAGE_SIZE = 50;
export const MAX_EVENT_PAGE_SIZE = 100;

/** List project-scoped retained events in newest-first order. */
export async function listProjectEvents(
  projectId: string,
  options: ListProjectEventsOptions = {},
  db: EventQueriesDb = getDb(),
): Promise<ProjectEventPage> {
  const limit = eventPageSize(options.limit);
  const rows = await db
    .select({
      id: otelLogs.id,
      occurredAt: otelLogs.occurredAt,
      eventName: otelLogs.eventName,
      traceId: otelLogs.traceId,
      spanId: otelLogs.spanId,
      serviceName: otelLogs.serviceName,
      experimentName: otelLogs.experimentName,
      experimentArm: otelLogs.experimentArm,
      experimentRole: otelLogs.experimentRole,
      body: otelLogs.body,
      experimentAttrs: otelLogs.experimentAttrs,
      attributes: otelLogs.attributes,
      attrsTruncated: otelLogs.attrsTruncated,
    })
    .from(otelLogs)
    .where(
      and(
        eq(otelLogs.projectId, projectId),
        options.since ? gte(otelLogs.occurredAt, options.since) : undefined,
        options.until ? lt(otelLogs.occurredAt, options.until) : undefined,
        options.eventName !== undefined
          ? containsText(otelLogs.eventName, options.eventName)
          : undefined,
        options.experiment !== undefined
          ? containsText(otelLogs.experimentName, options.experiment)
          : undefined,
        options.tracelessOnly ? isNull(otelLogs.traceId) : undefined,
        options.cursor
          ? or(
              lt(otelLogs.occurredAt, options.cursor.occurredAt),
              and(
                eq(otelLogs.occurredAt, options.cursor.occurredAt),
                lt(otelLogs.id, options.cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(otelLogs.occurredAt), desc(otelLogs.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null,
  };
}

function eventPageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_EVENT_PAGE_SIZE;
  }
  return Math.min(MAX_EVENT_PAGE_SIZE, Math.max(1, Math.trunc(limit)));
}
