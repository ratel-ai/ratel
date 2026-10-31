import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { OTLP_MODEL_CALL } from "@/lib/ingest/otlp/derive-model-calls";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import type { SetupCounts } from "@/lib/readings/trace-signals/setup-facts";

/**
 * The counts behind the setup facts, over one run window: per data point, how
 * many rows carried it. Counts only; each read rides the
 * (project, type, event time) index and filters the rest in place.
 */

export type SetupDb = Pick<ReturnType<typeof getDb>, "select">;

const at = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
const n = (filter?: ReturnType<typeof sql>) =>
  filter ? sql<number>`count(*) filter (where ${filter})::int` : sql<number>`count(*)::int`;

function inWindow(projectId: string, window: { start: Date; end: Date }, types: readonly string[]) {
  return and(
    eq(traceEvents.projectId, projectId),
    inArray(traceEvents.type, [...types]),
    sql`${at} >= ${window.start} and ${at} < ${window.end}`,
  );
}

async function otelCounts(projectId: string, window: { start: Date; end: Date }, db: SetupDb) {
  const [tools] = await db
    .select({
      rows: n(),
      session: n(sql`${traceEvents.payload} ->> 'has_session' = 'true'`),
      user: n(sql`${traceEvents.endUserId} is not null`),
      result: n(sql`${traceEvents.payload} ? 'result_empty'`),
      root: n(sql`${traceEvents.payload} ->> 'root_tool' = 'true'`),
      rootSession: n(
        sql`${traceEvents.payload} ->> 'root_tool' = 'true' and ${traceEvents.payload} ->> 'has_session' = 'true'`,
      ),
    })
    .from(traceEvents)
    .where(
      and(
        inWindow(projectId, window, ["invoke_end", "invoke_error"]),
        eq(traceEvents.ingestSource, "otlp"),
      ),
    );
  const [calls] = await db
    .select({
      rows: n(),
      prompt: n(sql`${traceEvents.payload} ? 'prompt'`),
      menu: n(sql`${traceEvents.payload} ? 'menu'`),
    })
    .from(traceEvents)
    .where(inWindow(projectId, window, [OTLP_MODEL_CALL]));
  return {
    toolRows: tools?.rows ?? 0,
    toolRowsWithSession: tools?.session ?? 0,
    toolRowsWithUser: tools?.user ?? 0,
    toolRowsWithResult: tools?.result ?? 0,
    rootToolRows: tools?.root ?? 0,
    rootToolRowsWithSession: tools?.rootSession ?? 0,
    modelCalls: calls?.rows ?? 0,
    modelCallsWithPrompt: calls?.prompt ?? 0,
    modelCallsWithMenu: calls?.menu ?? 0,
  };
}

const SDK_TYPES = [
  "search",
  "skill_search",
  "invoke_start",
  "invoke_end",
  "invoke_error",
  "skill_invoke",
] as const;

async function sdkCounts(projectId: string, window: { start: Date; end: Date }, db: SetupDb) {
  const [events] = await db
    .select({
      rows: n(),
      user: n(sql`${traceEvents.endUserId} is not null`),
      searches: n(sql`${traceEvents.type} in ('search', 'skill_search')`),
      queries: n(
        sql`${traceEvents.type} in ('search', 'skill_search') and ${traceEvents.query} is not null`,
      ),
    })
    .from(traceEvents)
    // Older rows carry no ingest source; anything not from OTLP is the SDK's.
    .where(
      and(
        inWindow(projectId, window, SDK_TYPES),
        sql`${traceEvents.ingestSource} is distinct from 'otlp'`,
      ),
    );
  const [turns] = await db
    .select({
      rows: n(),
      declared: n(sql`${traceTurns.turnSource} = 'declared'`),
      tools: n(sql`${traceTurns.invokeCount} > 0`),
    })
    .from(traceTurns)
    .where(
      and(
        eq(traceTurns.projectId, projectId),
        eq(traceTurns.lane, "runtime"),
        gte(traceTurns.endedAt, window.start),
        lt(traceTurns.endedAt, window.end),
      ),
    );
  const [starts] = await db
    .select({ messages: n(sql`coalesce(${traceEvents.payload} ->> 'user_message', '') <> ''`) })
    .from(traceEvents)
    .where(
      and(
        inWindow(projectId, window, ["turn_start"]),
        sql`${traceEvents.ingestSource} is distinct from 'otlp'`,
      ),
    );
  return {
    searches: events?.searches ?? 0,
    searchesWithQuery: events?.queries ?? 0,
    turns: turns?.rows ?? 0,
    declaredTurns: turns?.declared ?? 0,
    turnsWithTools: turns?.tools ?? 0,
    userMessages: starts?.messages ?? 0,
    events: events?.rows ?? 0,
    eventsWithUser: events?.user ?? 0,
  };
}

export async function loadSetupCounts(
  projectId: string,
  window: { start: Date; end: Date },
  db: SetupDb = getDb(),
): Promise<SetupCounts> {
  const [otel, sdk] = await Promise.all([
    otelCounts(projectId, window, db),
    sdkCounts(projectId, window, db),
  ]);
  return { otel, sdk };
}
