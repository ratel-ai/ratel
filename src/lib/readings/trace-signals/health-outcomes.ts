import {
  OUTCOME_FLOOR,
  type OutcomePillar,
  type PillarReading,
  RECOVERED_COST,
} from "@/lib/readings/trace-signals/health-pillars";
import {
  type DayBucket,
  totalOver,
  windowDays,
} from "@/lib/readings/trace-signals/signals/project-metrics";

/**
 * The measured half of the Health score (RC-226): how the reading's runs
 * actually went, as five rates, each a share of good outcomes in [0, 1]:
 *
 * - **runs end well**: SDK runs that did not dead-end (searched, ran
 *   nothing), OpenTelemetry runs whose last call did not fail;
 * - **right tool in top 5**: runs whose every tool sat in the top 5 of a
 *   search before it was called (recall at 5). Whether the agent took it
 *   first does not matter: served where the agent reads, it picks well. Read
 *   from searches, so an OpenTelemetry-only project leaves it out (its tool
 *   switches count as self-corrections);
 * - **no self-corrections**: runs where the agent did not correct itself; a
 *   correction it recovered from costs half ({@link RECOVERED_COST});
 * - **tasks finish**: task runs that did not fail, weighted by runs;
 * - **calls work**: OpenTelemetry calls neither failed nor wasted. The SDK
 *   buckets count wasted calls but not calls, and one run can hold dozens
 *   (an MCP session is one run), so an SDK-only project leaves this out.
 *   Model and code steps count too, and a failed one is a bad outcome
 *   (RC-1077).
 *
 * Each is read over the reading's own window from what the run stored
 * (daily buckets, `selfCorrections`, `workflows`), so the page and the job
 * that stores the score read the same numbers. A rate with fewer than
 * {@link OUTCOME_FLOOR} observations is left out, and the others share its
 * weight. SDK and OpenTelemetry runs add up in the same rate, so a mixed
 * project is read as one.
 */

export * from "@/lib/readings/trace-signals/health-pillars";

/** The parts of a stored run summary the rates read. */
export interface OutcomeSummary {
  daily?: readonly DayBucket[];
  selfCorrections?: unknown;
  workflows?: unknown;
}

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function rate(pillar: OutcomePillar, bad: number, n: number): PillarReading | null {
  if (n < OUTCOME_FLOOR) return null;
  return { pillar, good: Math.min(1, Math.max(0, 1 - bad / n)), n };
}

function ended(total: DayBucket): PillarReading | null {
  const otel = total.otel;
  const n = total.shaped + num(otel?.turns);
  const bad = total.shapes.dead_end + Math.max(0, num(otel?.turns) - num(otel?.completed));
  return rate("ended", bad, n);
}

function top5(total: DayBucket): PillarReading | null {
  // Absent on readings stored before it: no rate, rather than a different one.
  const n = num(total.top5N);
  return rate("top_5", n - num(total.top5), n);
}

function corrections(raw: unknown): PillarReading | null {
  const stored = record(raw);
  if (record(stored.trust).runs === "none") return null;
  const turns = num(stored.turns);
  const corrected =
    typeof stored.correctedTurns === "number"
      ? stored.correctedTurns
      : Math.min(turns, num(stored.events));
  const recovered = Math.min(corrected, num(stored.recoveredTurns));
  return rate("corrections", corrected - recovered + recovered * RECOVERED_COST, turns);
}

function tasks(raw: unknown): PillarReading | null {
  const workflows = record(raw);
  // Runs mixed together cannot be told apart into tasks: no task rate is true then.
  if (record(workflows.basis).blocked) return null;
  const items = Array.isArray(workflows.items) ? workflows.items.map(record) : [];
  const runs = items.reduce((sum, item) => sum + num(item.runs), 0);
  const failed = items.reduce(
    (sum, item) => sum + Math.min(num(item.runs), num(record(item.health).failedRuns)),
    0,
  );
  return rate("tasks", failed, runs);
}

function calls(total: DayBucket): PillarReading | null {
  // Model and code steps are absent on days without one, and on readings stored before RC-1077.
  const n = num(total.otel?.calls) + num(total.steps?.calls);
  return rate(
    "calls",
    Math.min(n, num(total.otel?.failedCalls) + num(total.otel?.wasted) + num(total.steps?.failed)),
    n,
  );
}

/** The rates of one reading, over its own window; the ones without enough evidence are left out. */
export function outcomePillars(
  summary: OutcomeSummary,
  window: { end: Date; days: number },
): PillarReading[] {
  const total = totalOver(summary.daily ?? [], windowDays(window.end, window.days));
  return [
    ended(total),
    top5(total),
    corrections(summary.selfCorrections),
    tasks(summary.workflows),
    calls(total),
  ].filter((reading): reading is PillarReading => reading !== null);
}
