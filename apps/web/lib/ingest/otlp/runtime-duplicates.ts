import type { ParsedTraceEvent } from "@/lib/ingest/trace-events/parse";

/**
 * The per-row guard between the Ratel SDK and OpenTelemetry on one project.
 *
 * A project may send both: the SDK publishes `invoke_*` facts for the tool
 * calls it sees, and the customer's OTel exporter sends tool spans for calls,
 * some of them the very same calls. An OTel tool row is a duplicate when the
 * SDK recorded an invoke of the same tool in the same session within
 * {@link RUNTIME_DUPLICATE_WINDOW_MS} of it; only those are dropped. Tool rows
 * of another agent (other sessions), and every model-call row (the SDK never
 * sends those), are kept.
 *
 * Pure: the read lives in `runtime-facts-query.ts`.
 */

export const RUNTIME_DUPLICATE_WINDOW_MS = 5_000;

const TOOL_ROW_TYPES: ReadonlySet<string> = new Set(["invoke_end", "invoke_error"]);

/** One SDK invoke, as much of it as the guard needs. */
export interface RuntimeInvoke {
  sessionId: string;
  toolId: string;
  at: Date;
}

/** What one export batch asks the store: its sessions, tools and time span (widened by the window). */
export interface RuntimeInvokeProbe {
  sessionIds: readonly string[];
  toolIds: readonly string[];
  from: Date;
  to: Date;
}

export type FindRuntimeInvokes = (
  projectId: string,
  probe: RuntimeInvokeProbe,
) => Promise<readonly RuntimeInvoke[]>;

export function isOtelToolRow(
  row: Pick<ParsedTraceEvent, "type" | "toolId" | "sessionId">,
): boolean {
  return TOOL_ROW_TYPES.has(row.type) && !!row.toolId && !!row.sessionId;
}

const keyOf = (sessionId: string, toolId: string): string => `${sessionId}\u0000${toolId}`;

/** The probe for a batch's tool rows; null when it has none. */
export function runtimeInvokeProbe(
  rows: readonly ParsedTraceEvent[],
  windowMs: number = RUNTIME_DUPLICATE_WINDOW_MS,
): RuntimeInvokeProbe | null {
  const tools = rows.filter(isOtelToolRow);
  if (tools.length === 0) return null;
  const times = tools.map((row) => row.occurredAt.getTime());
  return {
    sessionIds: [...new Set(tools.map((row) => row.sessionId!))].sort(),
    toolIds: [...new Set(tools.map((row) => row.toolId!))].sort(),
    from: new Date(Math.min(...times) - windowMs),
    to: new Date(Math.max(...times) + windowMs),
  };
}

/** The rows without the OTel tool rows an SDK invoke already describes. */
export function withoutRuntimeDuplicates(
  rows: readonly ParsedTraceEvent[],
  invokes: readonly RuntimeInvoke[],
  windowMs: number = RUNTIME_DUPLICATE_WINDOW_MS,
): ParsedTraceEvent[] {
  if (invokes.length === 0) return [...rows];
  const times = new Map<string, number[]>();
  for (const invoke of invokes) {
    const key = keyOf(invoke.sessionId, invoke.toolId);
    times.set(key, [...(times.get(key) ?? []), invoke.at.getTime()]);
  }
  return rows.filter((row) => {
    if (!isOtelToolRow(row)) return true;
    const at = row.occurredAt.getTime();
    const near = times.get(keyOf(row.sessionId!, row.toolId!)) ?? [];
    return !near.some((t) => Math.abs(t - at) <= windowMs);
  });
}
