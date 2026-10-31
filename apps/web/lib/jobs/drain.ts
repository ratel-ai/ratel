import { drainSteps } from "@/lib/composition/registry";
import type { DrainStep } from "@/lib/contracts/registry";
import {
  type BackgroundObservability,
  type BackgroundObservabilityDeps,
  createBackgroundObservability,
  defaultBackgroundObservabilityDeps,
} from "./observability";
import { drainProjectJobs } from "./store";

/**
 * One cron tick (owned port of the upstream drain): the registered `before` steps (the safety-net
 * enqueues), the job drain, then the registered `after` steps (sweeps, refreshes, and the pruning
 * passes that run only with retention on). Every step is isolated: a failure is recorded under
 * its name and never costs the drain its job durability. The tick always emits
 * `cron_drain_completed`, stamped `ok: false` with the reason when it threw.
 *
 * Upstream enumerated its steps in this file; here `jobs/` knows only the registry, so a module
 * (core or private) adds a step by exporting it from its `register.ts`. Two deliberate changes
 * from upstream: every step is isolated (upstream let the query-categorization enqueue and the
 * retention prunes throw, which failed the whole tick), and a step emits its own typed event
 * when it did work (upstream emitted `trace_summaries_refreshed` and friends from here).
 */
export interface DrainCronDeps {
  steps: DrainStep[];
  drainProjectJobs: () => Promise<{ done: number; failed: number }>;
  /** Whether this tick may delete anything. Steps marked `retentionOnly` are skipped otherwise. */
  retentionEnabled?: boolean;
  observability?: BackgroundObservabilityDeps;
}

export type DrainSummary = {
  ok: boolean;
  done: number;
  failed: number;
  retention: boolean;
  steps: Record<string, unknown>;
  errors?: Record<string, string>;
  error?: string;
  duration_ms: number;
};

/** Retention deletion is opt-in by the operator (`DATA_RETENTION_ENABLED=1`). */
export function dataRetentionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.DATA_RETENTION_ENABLED?.trim() === "1";
}

const defaultDeps = (): DrainCronDeps => ({
  steps: drainSteps(),
  drainProjectJobs: () => drainProjectJobs(),
  retentionEnabled: dataRetentionEnabled(),
  observability: defaultBackgroundObservabilityDeps,
});

/** Run one tick and return its summary; the HTTP route and the in-process scheduler both call this. */
export async function runDrainTick(deps: DrainCronDeps = defaultDeps()): Promise<DrainSummary> {
  const observability = createBackgroundObservability(
    deps.observability ?? defaultBackgroundObservabilityDeps,
  );
  const startedAt = observability.now();
  const retention = deps.retentionEnabled !== false;
  const summary: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  let done = 0;
  let failed = 0;
  let ok = false;
  let error: string | undefined;
  try {
    for (const step of deps.steps.filter((s) => s.phase === "before")) {
      summary[step.name] = await isolated(step, observability, errors);
    }
    ({ done, failed } = await deps.drainProjectJobs());
    for (const step of deps.steps.filter((s) => s.phase === "after")) {
      if (step.retentionOnly && !retention) {
        summary[step.name] = "skipped";
        continue;
      }
      summary[step.name] = await isolated(step, observability, errors);
    }
    ok = true;
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  const result: DrainSummary = {
    ok,
    done,
    failed,
    retention,
    steps: summary,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
    ...(error !== undefined ? { error } : {}),
    duration_ms: Math.max(0, observability.now() - startedAt),
  };
  await observability.trackSystemEvent("cron_drain_completed", "system:cron", {
    ok,
    done,
    failed,
    retention,
    duration_ms: result.duration_ms,
    ...heartbeatProperties(summary),
    ...(Object.keys(errors).length > 0 ? { errors: Object.keys(errors).join(",") } : {}),
    ...(error !== undefined ? { error } : {}),
  });
  return result;
}

/**
 * GET /api/cron/drain: one tick for an external scheduler. Closed unless `CRON_SECRET` is set
 * and presented as a bearer: an open route would let any caller drive background work,
 * including jobs that spend the operator's model keys. The open-source edition never needs
 * the route, its scheduler runs the tick in process.
 */
export async function drainCron(req: Request, deps?: DrainCronDeps): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return new Response("CRON_SECRET is not configured", { status: 401 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const summary = await runDrainTick(deps);
  return Response.json(summary, { status: summary.ok ? 200 : 500 });
}

/** Run a step whose failure should degrade the drain rather than end it. */
async function isolated(
  step: DrainStep,
  observability: BackgroundObservability,
  errors: Record<string, string>,
): Promise<unknown> {
  try {
    return (await step.run()) ?? null;
  } catch (thrown) {
    errors[step.name] = thrown instanceof Error ? thrown.message : String(thrown);
    observability.reportException("drain step failed", thrown, "system:cron", { step: step.name });
    return null;
  }
}

/**
 * Step results as flat heartbeat properties: a numeric result lands under the step's name, an
 * object's numeric and boolean fields land under their own names. Upstream's heartbeat was one
 * flat object and its dashboards join on those keys, so a step keeps them by naming its fields
 * the same way; a field two steps both report is last-writer-wins.
 */
function heartbeatProperties(summary: Record<string, unknown>): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const [name, value] of Object.entries(summary)) {
    if (typeof value === "number") out[name] = value;
    else if (value && typeof value === "object") {
      for (const [field, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "number" || typeof v === "boolean") out[field] = v;
      }
    }
  }
  return out;
}
