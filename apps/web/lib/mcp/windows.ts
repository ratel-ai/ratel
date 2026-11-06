import { z } from "zod";
import { invalidParams } from "@/lib/mcp/errors";

/**
 * Bounded time ranges for MCP reads.
 *
 * Agents ask for ranges no human ever clicks: "the last year, everything" is a
 * natural way to phrase a question and a very unnatural query to run against
 * the span tables. Every windowed operation therefore has a default and a hard
 * maximum, and an over-wide request is clamped (with the effective window
 * reported back) rather than refused: the agent still gets an answer, and it
 * can see it did not get the range it asked for.
 */
export const DAY_MS = 86_400_000;

export interface WindowBounds {
  /** Days covered when the caller specifies nothing. */
  defaultDays: number;
  /** Hard ceiling; wider requests are clamped to this. */
  maxDays: number;
}

export const WINDOW_PRESETS = {
  /** Trace-level reads: high row counts, expensive joins. */
  traces: { defaultDays: 1, maxDays: 30 },
  /** Pre-aggregated daily rollups: cheap, so a wider ceiling is fine. */
  aggregates: { defaultDays: 7, maxDays: 90 },
  /** Catalog and entity reads that carry an activity window. */
  entities: { defaultDays: 30, maxDays: 90 },
} as const satisfies Record<string, WindowBounds>;

/** The `since`/`until` params every windowed operation shares. */
export const windowParams = {
  since: z
    .string()
    .datetime()
    .optional()
    .describe("ISO-8601 start of the window. Defaults per operation."),
  until: z.string().datetime().optional().describe("ISO-8601 end of the window. Defaults to now."),
};

export interface ResolvedWindow {
  since: Date;
  until: Date;
  /** True when the requested range was wider than `maxDays` and was clamped. */
  clamped: boolean;
  /** Serializable form for the operation result envelope. */
  toJSON(): { since: string; until: string };
}

export function resolveWindow(
  params: { since?: string; until?: string },
  bounds: WindowBounds,
  now: Date = new Date(),
): ResolvedWindow {
  const until = params.until ? new Date(params.until) : now;
  if (Number.isNaN(until.getTime())) {
    throw invalidParams("`until` is not a valid ISO-8601 timestamp.");
  }

  const requestedSince = params.since
    ? new Date(params.since)
    : new Date(until.getTime() - bounds.defaultDays * DAY_MS);
  if (Number.isNaN(requestedSince.getTime())) {
    throw invalidParams("`since` is not a valid ISO-8601 timestamp.");
  }
  if (requestedSince.getTime() > until.getTime()) {
    throw invalidParams("`since` must be earlier than `until`.");
  }

  const earliest = new Date(until.getTime() - bounds.maxDays * DAY_MS);
  const clamped = requestedSince.getTime() < earliest.getTime();
  const since = clamped ? earliest : requestedSince;

  return {
    since,
    until,
    clamped,
    toJSON: () => ({ since: since.toISOString(), until: until.toISOString() }),
  };
}
