import { loadOrFallback } from "@/lib/platform/resilient-read";
import type { HealthPageModel, WindowDays } from "@/lib/readings/trace-signals/view";
import type { ImportSummary } from "@/lib/views/health/imports-types";
import type { LedgerFacts, RunFacts } from "@/lib/views/health/ledger-facts";
import { loadLedgerFacts, loadRunFacts } from "@/lib/views/health/ledger-facts-query";
import {
  cooldownPassed,
  type HealthPageState,
  healthPageState,
  readingRequestDue,
} from "@/lib/views/health/page-state";
import { requestHealthReading } from "@/lib/views/health/reading-request";
import { isHealthUnlocked } from "@/lib/views/health/unlock";

/**
 * The Agent health route's state, end to end. A page whose reading has
 * enough turns is `ready`; it reads nothing more unless that reading started
 * while turns were still being built (`model.unbuiltAtReading`), in which
 * case it asks for one that reads them and watches for it, or it is early
 * (`model.earlyReading`, RC-224), in which case it asks for the full one the
 * same way. Any other page
 * reads the ledger, decides what is true (`healthPageState`), and, when it is
 * about to say a reading is being built while nothing is on its way, asks for
 * one. Never inside an admin support session, which only looks.
 *
 * An early reading that read none of the imported runs it counts
 * (`model.emptyEarlyReading`, RC-255) is not ready: the ledger says whether
 * the runs are imported, and the page says the reading is being built.
 *
 * A turn count without a computed run (`computedAt` null: the live count
 * before a first reading) is not a reading. A read that failed is never taken
 * for an empty project: a reading that did not load is `unavailable` (and
 * asks for nothing), and so is a ledger that did not load, unless the model
 * counts some turns but fewer than a reading needs: null then, and the
 * model's own "collecting" meter is true. Failures are logged and reported
 * by `loadOrFallback`.
 */

export interface PageStateDeps {
  loadFacts: (
    projectId: string,
    options: { now: Date; countImported: boolean; windowDays: WindowDays },
  ) => Promise<LedgerFacts | null>;
  loadRuns: (projectId: string, now: Date) => Promise<RunFacts | null>;
  requestReading: typeof requestHealthReading;
  now: () => Date;
}

const defaultDeps: PageStateDeps = {
  loadFacts: (projectId, options) =>
    loadOrFallback<LedgerFacts | null>({
      operation: "agent_health_ledger_facts",
      distinctId: `project:${projectId}`,
      fallback: null,
      load: () => loadLedgerFacts(projectId, options),
    }),
  loadRuns: (projectId, now) =>
    loadOrFallback<RunFacts | null>({
      operation: "agent_health_run_facts",
      distinctId: `project:${projectId}`,
      fallback: null,
      load: () => loadRunFacts(projectId, now),
    }),
  requestReading: requestHealthReading,
  now: () => new Date(),
};

export interface PageStateInput {
  projectId: string;
  organizationId: string;
  model: Pick<
    HealthPageModel,
    | "windowDays"
    | "turns"
    | "floor"
    | "waitingOn"
    | "computedAt"
    | "unbuiltAtReading"
    | "earlyReading"
    | "emptyEarlyReading"
  >;
  /** The model is the empty fallback of a failed read, not the project's reading. */
  modelUnavailable?: boolean;
  /** Null when they could not be read: unknown, which is not none. */
  imports: readonly ImportSummary[] | null;
  /** The plan's `agentHealthWindowDays`. */
  planWindowDays: number;
  /** An admin support session: decide, but never ask for work. */
  readOnly: boolean;
}

const UNAVAILABLE: HealthPageState = { kind: "unavailable" };
const READY: HealthPageState = { kind: "ready" };

export async function loadHealthPageState(
  input: PageStateInput,
  overrides: Partial<PageStateDeps> = {},
): Promise<HealthPageState | null> {
  const deps = { ...defaultDeps, ...overrides };
  if (input.modelUnavailable) return UNAVAILABLE;
  const now = deps.now();
  const hasReading = input.model.computedAt !== null;
  // The one rule the Overview's Needs attention reads too (RTL-367).
  const readingReady = isHealthUnlocked(input.model);
  if (readingReady && !input.model.emptyEarlyReading) return readyState(input, deps, now);

  const imports = input.imports;
  const countImported = (imports ?? []).some(
    (item) => item.runsImported > 0 || item.status === "running",
  );
  const ledger = await deps.loadFacts(input.projectId, {
    now,
    countImported,
    windowDays: input.model.windowDays,
  });
  if (!ledger && readingReady) return readyState(input, deps, now);
  // Unreadable: the model's own "collecting" meter is still true; nothing else can be said.
  if (!ledger)
    return input.model.turns > 0 && input.model.turns < input.model.floor ? null : UNAVAILABLE;
  const state = healthPageState({
    windowDays: input.model.windowDays,
    readingTurns: hasReading ? input.model.turns : 0,
    floor: input.model.floor,
    ledger,
    imports,
    planWindowDays: input.planWindowDays,
    waitingOn: input.model.waitingOn,
    emptyEarlyReading: input.model.emptyEarlyReading,
  });
  // Only a reading with an empty mark gets here ready: its runs are not imported, so it is the page as usual.
  if (state.kind === "ready") return readyState(input, deps, now);
  if (input.readOnly || state.kind !== "building" || !readingRequestDue(state, ledger, now))
    return state;
  const requested = await deps.requestReading({
    projectId: input.projectId,
    organizationId: input.organizationId,
    reason: state.imported ? "imported_runs_unread" : "turns_unread",
  });
  return requested ? { ...state, working: true } : state;
}

/**
 * A reading with enough turns is the page. One that started while turns were
 * still being built missed them, and an early one is not the full reading:
 * ask for one that reads everything (once the cooldown allows) and watch for it.
 */
async function readyState(
  input: PageStateInput,
  deps: PageStateDeps,
  now: Date,
): Promise<HealthPageState> {
  if (!input.model.unbuiltAtReading && !input.model.earlyReading) return READY;
  const runs = await deps.loadRuns(input.projectId, now);
  if (!runs) return READY;
  if (runs.working) return { kind: "ready", updating: true };
  if (input.readOnly || !cooldownPassed(runs, now)) return READY;
  const requested = await deps.requestReading({
    projectId: input.projectId,
    organizationId: input.organizationId,
    reason: input.model.earlyReading ? "reading_early" : "reading_partial",
  });
  return requested ? { kind: "ready", updating: true } : READY;
}
