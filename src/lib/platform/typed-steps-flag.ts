import type { FlagSubject } from "@/lib/contracts/feature-flags";
import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";

/**
 * `FF_TYPED_STEPS`: typed steps (ratel-cloud RC-1067 and its milestones, upstream's
 * `cloud-typed-steps`). On, OTLP ingest also writes code and handoff steps and model-call
 * identities, and the turn build reads model calls, code steps, handoffs and user messages as
 * steps, so a trace with model calls only makes a turn. Off, ingest and the turn build give the
 * same rows as before.
 *
 * A core switch (ADR-0030), off by default. Without the edition's flags port it is one switch for
 * the deployment, read from the environment (or `RATEL_EXPERIMENTAL_FEATURES` in the open-source
 * edition); with it, the edition decides it for the project (`featureEnabled`). It lives in the
 * platform layer because ingest and the turn ledger read it too; the readings call it through
 * `readings/trace-signals/typed-steps.ts`, which keeps upstream's names.
 */
export const TYPED_STEPS_FLAG = "FF_TYPED_STEPS" as const;

/** Whether typed steps are on for this subject (a project, at least). Never throws: a failed decision is off. */
export function typedStepsOn(
  subject: FlagSubject,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled(TYPED_STEPS_FLAG, subject, deps);
}
