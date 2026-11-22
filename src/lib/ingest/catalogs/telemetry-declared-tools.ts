import { sql } from "drizzle-orm";
import { OTLP_MODEL_CALL } from "@/lib/ingest/otlp/derive-model-calls";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";

/**
 * The tools an agent declared in its telemetry (AOBS-7): the names in
 * `gen_ai.tool.definitions` of its model calls. Ingest keeps them, names only,
 * as the `menu` of each `otlp_model_call` row (`otlp/derive-model-calls.ts`).
 * An agent that sends traces and does not sync a catalog through the SDK (a
 * coding agent) declares its tools only this way.
 */

export interface TelemetryDeclaredTool {
  name: string;
  /** The start of the latest model call that declared it. */
  lastDeclaredAt: Date;
  /** Model calls in the window that declared it. */
  modelCalls: number;
}

export type TelemetryDeclaredToolsDb = Pick<ReturnType<typeof getDb>, "execute">;

/** How far back a declaration counts: the retention of raw telemetry. */
const WINDOW_DAYS = 30;
export const TELEMETRY_DECLARED_TOOLS_LIMIT = 1_000;

/** The declared tool names of the last 30 days, by name. At most 1,000. */
export async function listTelemetryDeclaredTools(
  projectId: string,
  options: { now?: Date } = {},
  db: TelemetryDeclaredToolsDb = getDb(),
): Promise<TelemetryDeclaredTool[]> {
  const since = new Date((options.now ?? new Date()).getTime() - WINDOW_DAYS * 86_400_000);
  const result = await db.execute(sql`
    select tool.name as name, max(${traceEvents.occurredAt}) as last_declared_at, count(*)::int as model_calls
    from ${traceEvents}
    cross join lateral jsonb_array_elements_text(${traceEvents.payload} -> 'menu') as tool(name)
    where ${traceEvents.projectId} = ${projectId}
      and ${traceEvents.type} = ${OTLP_MODEL_CALL}
      and ${traceEvents.occurredAt} >= ${since.toISOString()}
      and jsonb_typeof(${traceEvents.payload} -> 'menu') = 'array'
    group by tool.name
    order by tool.name asc
    limit ${TELEMETRY_DECLARED_TOOLS_LIMIT}
  `);
  return result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      name: String(row.name),
      lastDeclaredAt: new Date(String(row.last_declared_at)),
      modelCalls: Number(row.model_calls ?? 0),
    };
  });
}
