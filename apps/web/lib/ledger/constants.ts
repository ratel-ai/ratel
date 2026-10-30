import { TURN_EVENT_TYPES } from "@/lib/ingest/trace-events/turns-schedule";
import { envNumber } from "@/lib/platform/env-number";

/**
 * Tuning knobs for the turn ledger. Every boundary threshold is env-overridable so a
 * deployment can correct the inferred-turn rule without a release. Pure code takes a
 * {@link TurnConfig} argument defaulting to these, so tests pin their own values.
 *
 * Owned (ADR-0030): `TURN_EVENT_TYPES` has one source, the ingest kick in
 * `lib/ingest/trace-events/turns-schedule.ts`, re-exported here so the ledger reads the
 * same list that triggers it. Imported sources are recognised by their `-import` suffix
 * rather than an enumerated vendor list.
 */

/** The runtime event types a turn is made of. Mirrors the partial index on `trace_events`. */
export { TURN_EVENT_TYPES };

/** A silence longer than this between two events of a session starts a new inferred turn. */
export const INFERRED_TURN_GAP_MS = envNumber("TRACE_TURNS_INFERRED_GAP_MS", 90_000);
/** An inferred turn never holds more steps than this. */
export const TURN_STEP_CAP = Math.floor(envNumber("TRACE_TURNS_STEP_CAP", 40));
/** An inferred turn never spans more event time than this. */
export const TURN_DURATION_CAP_MS = envNumber("TRACE_TURNS_DURATION_CAP_MS", 15 * 60_000);
/** A turn whose session has been quiet (by receipt time) this long is closed. */
export const TURN_IDLE_CLOSE_MS = envNumber("TRACE_TURNS_IDLE_CLOSE_MS", 30 * 60_000);

/**
 * An Agent health import stores its runs under `<source>-import` (the `service.name`
 * its spans carry). An import is history read once: nothing more arrives for its runs.
 */
export const IMPORTED_SOURCE_SUFFIX = "-import";

/** Whether a row came from an Agent health import rather than live telemetry. */
export function isImportedSourceId(sourceId: string | null | undefined): boolean {
  return typeof sourceId === "string" && sourceId.endsWith(IMPORTED_SOURCE_SUFFIX);
}

/** A gateway row this close to a native row it summarizes is the same fact. */
export const GATEWAY_DEDUPE_WINDOW_MS = envNumber("TRACE_TURNS_GATEWAY_DEDUPE_MS", 2_000);
/** An invocation end without an `invocation_id` pairs with a start at most this old. */
export const INVOCATION_PAIRING_WINDOW_MS = envNumber("TRACE_TURNS_PAIRING_WINDOW_MS", 10 * 60_000);

/** Hit ids kept per search step; bounds the row and every attribution scan. */
export const MAX_STEP_HIT_IDS = 32;

/** Events read per build page. */
export const TURN_BUILD_PAGE_LIMIT = 5_000;
/** Pages one build job processes before handing the rest to a fresh job. */
export const TURN_BUILD_MAX_PAGES = 10;
/** Wall-clock budget of one build job, well inside the stale-job reaper. */
export const TURN_BUILD_TIME_BUDGET_MS = 4 * 60_000;
/** The first build seeds from this window, the runtime-event retention. A cursor
 * older than it means events were pruned before they were built. */
export const TURN_BUILD_SEED_WINDOW_DAYS = 30;
/** The cron safety net skips a project whose last build errored this recently. */
export const TURN_BUILD_ERROR_BACKOFF_MS = 60 * 60_000;
/** Projects the cron safety net enqueues per tick at most. */
export const TURN_BUILD_DUE_LIMIT = 200;

/** The boundary thresholds, as one value the pure pipeline can take. */
export interface TurnConfig {
  gapMs: number;
  stepCap: number;
  durationCapMs: number;
  idleCloseMs: number;
  gatewayDedupeMs: number;
  pairingWindowMs: number;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  gapMs: INFERRED_TURN_GAP_MS,
  stepCap: TURN_STEP_CAP,
  durationCapMs: TURN_DURATION_CAP_MS,
  idleCloseMs: TURN_IDLE_CLOSE_MS,
  gatewayDedupeMs: GATEWAY_DEDUPE_WINDOW_MS,
  pairingWindowMs: INVOCATION_PAIRING_WINDOW_MS,
};
