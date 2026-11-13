/**
 * What a project sends us, data point by data point, so the page can tell the
 * customer what to turn on for better results. Computed by the signal run from
 * rows we already store (`setup-facts-query.ts`) and kept in
 * `trace_signal_runs.summary.setup`; the page reads it back with
 * {@link parseStoredSetup}. Counts only: no text.
 *
 * Every customer kind is covered: SDK only, OpenTelemetry only, both, or
 * neither (no runs at all, which the page's collecting state handles).
 */

export type SetupKey =
  | "otel_tool_spans"
  | "otel_model_calls"
  | "otel_conversation_id"
  | "otel_user_id"
  | "otel_content"
  | "otel_tool_definitions"
  | "otel_trace_context"
  | "sdk_tool_calls"
  | "sdk_search_queries"
  | "sdk_turn_ids"
  | "sdk_user_messages"
  | "sdk_end_users"
  | "both_linked";

import {
  ONE_TOOL_PER_TRACE_MIN_SHARE,
  oneToolPerTrace,
} from "@/lib/readings/trace-signals/otel-trace-shape";

/** on: always sent; partial: sometimes; off: never. */
export type SetupStatus = "on" | "partial" | "off";

export interface SetupFact {
  key: SetupKey;
  status: SetupStatus;
  /** Share of the relevant rows that carried it, in [0, 1]. */
  share: number;
}

/** What the data itself shows is wrong, beyond a data point not being sent. */
export type SetupWarning = "mixed_runs";

export interface StoredSetup {
  version: 1;
  /** Which lanes the window had: decides which facts apply. */
  lanes: { sdk: boolean; otel: boolean };
  facts: SetupFact[];
  /** mixed_runs: runs without turn ids hold several users' calls, so workflows are hidden. Absent on older runs. */
  warnings?: SetupWarning[];
}

/** Raw counts over the run window, from `setup-facts-query.ts`. */
export interface SetupCounts {
  otel: {
    toolRows: number;
    toolRowsWithSession: number;
    toolRowsWithUser: number;
    /** Tool rows carrying a captured result (`result_empty` present). */
    toolRowsWithResult: number;
    modelCalls: number;
    modelCallsWithPrompt: number;
    modelCallsWithMenu: number;
    /** Tool rows that were the root span of their own trace (one call per trace), and of those, with a session. Absent reads as 0. */
    rootToolRows?: number;
    rootToolRowsWithSession?: number;
  };
  sdk: {
    searches: number;
    searchesWithQuery: number;
    turns: number;
    declaredTurns: number;
    /** Runs that called at least one tool. */
    turnsWithTools: number;
    /** Turn scopes that sent the user's message (`turn_start.user_message`). */
    userMessages: number;
    events: number;
    eventsWithUser: number;
  };
}

/** A share at or above this reads as "on"; above zero, "partial". */
export const SETUP_ON_SHARE = 0.9;
/**
 * Tool calls read as "on" from half the runs: an agent may search and then
 * answer without a tool, so a run without one is not missing data.
 */
export const TOOL_CALLS_ON_SHARE = 0.5;

function fact(
  key: SetupKey,
  part: number,
  whole: number,
  onShare: number = SETUP_ON_SHARE,
): SetupFact {
  const share = whole > 0 ? Math.min(1, part / whole) : 0;
  const status: SetupStatus = share >= onShare ? "on" : share > 0 ? "partial" : "off";
  return { key, status, share: Math.round(share * 10_000) / 10_000 };
}

/** SDK runs in the window, and those linked to OpenTelemetry model calls (from the signal run). */
export interface SetupLinking {
  sdkRuns: number;
  linkedRuns: number;
}

/**
 * The facts that apply to the lanes the project actually sent. A project
 * sending both also gets `both_linked`: the share of its SDK runs linked to
 * OpenTelemetry model calls (by the same session id on both).
 */
export function buildSetupFacts(
  counts: SetupCounts,
  linking?: SetupLinking,
  /** From the workflow basis: runs without turn ids read as several users mixed together. */
  observed: { mixedRuns?: boolean } = {},
): StoredSetup {
  const { otel, sdk } = counts;
  const lanes = { sdk: sdk.events > 0, otel: otel.toolRows > 0 || otel.modelCalls > 0 };
  const facts: SetupFact[] = [];
  if (lanes.otel) {
    facts.push(
      fact("otel_tool_spans", otel.toolRows > 0 ? 1 : 0, 1),
      fact("otel_model_calls", otel.modelCalls > 0 ? 1 : 0, 1),
      fact("otel_conversation_id", otel.toolRowsWithSession, otel.toolRows),
      fact("otel_user_id", otel.toolRowsWithUser, otel.toolRows),
      fact(
        "otel_content",
        Math.max(otel.modelCallsWithPrompt, otel.toolRowsWithResult > 0 ? otel.modelCalls : 0),
        otel.modelCalls,
      ),
      fact("otel_tool_definitions", otel.modelCallsWithMenu, otel.modelCalls),
    );
    // Each tool call in its own trace (an MCP server without trace context): one request is not one run.
    const shape = oneToolPerTrace({
      toolRows: otel.toolRows,
      rootToolRows: otel.rootToolRows ?? 0,
      rootToolRowsWithSession: otel.rootToolRowsWithSession ?? 0,
    });
    if (shape.verdict !== "not_enough_data") {
      facts.push(
        fact(
          "otel_trace_context",
          otel.toolRows - (otel.rootToolRows ?? 0),
          otel.toolRows,
          1 - ONE_TOOL_PER_TRACE_MIN_SHARE,
        ),
      );
    }
  }
  if (lanes.sdk) {
    facts.push(fact("sdk_tool_calls", sdk.turnsWithTools, sdk.turns, TOOL_CALLS_ON_SHARE));
    // A project that never searches through Ratel has no queries to send.
    if (sdk.searches > 0)
      facts.push(fact("sdk_search_queries", sdk.searchesWithQuery, sdk.searches));
    facts.push(
      fact("sdk_turn_ids", sdk.declaredTurns, sdk.turns),
      fact("sdk_user_messages", sdk.userMessages, sdk.turns),
      fact("sdk_end_users", sdk.eventsWithUser, sdk.events),
    );
  }
  if (lanes.sdk && lanes.otel && linking && linking.sdkRuns > 0) {
    facts.push(fact("both_linked", linking.linkedRuns, linking.sdkRuns));
  }
  const warnings: SetupWarning[] = lanes.sdk && observed.mixedRuns ? ["mixed_runs"] : [];
  return { version: 1, lanes, facts, ...(warnings.length > 0 ? { warnings } : {}) };
}

const KEYS: ReadonlySet<string> = new Set<SetupKey>([
  "otel_tool_spans",
  "otel_model_calls",
  "otel_conversation_id",
  "otel_user_id",
  "otel_content",
  "otel_tool_definitions",
  "otel_trace_context",
  "sdk_tool_calls",
  "sdk_search_queries",
  "sdk_turn_ids",
  "sdk_user_messages",
  "sdk_end_users",
  "both_linked",
]);
const STATUSES: ReadonlySet<string> = new Set<SetupStatus>(["on", "partial", "off"]);

/** The stored facts, or null for runs stored before them or junk. */
export function parseStoredSetup(value: unknown): StoredSetup | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<StoredSetup>;
  if (record.version !== 1 || !record.lanes || !Array.isArray(record.facts)) return null;
  const facts = record.facts.filter(
    (f): f is SetupFact =>
      !!f &&
      typeof f === "object" &&
      KEYS.has(f.key) &&
      STATUSES.has(f.status) &&
      typeof f.share === "number",
  );
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((w): w is SetupWarning => w === "mixed_runs")
    : [];
  return {
    version: 1,
    lanes: { sdk: record.lanes.sdk === true, otel: record.lanes.otel === true },
    facts,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** The facts the customer should act on: anything not fully on. */
export function missingSetup(setup: StoredSetup | null): SetupFact[] {
  return setup ? setup.facts.filter((f) => f.status !== "on") : [];
}
