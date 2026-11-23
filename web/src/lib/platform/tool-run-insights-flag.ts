import type { FlagSubject } from "@/lib/contracts/feature-flags";
import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";

/**
 * `toolRunInsights`: tool-run insights (ratel-cloud RC-725 and its follow-ups, upstream's
 * `cloud-tool-run-insights`). On, Tasks mine small projects (a floor of three runs), a tool-only
 * run reads a derived ask in Intents, an OTel `invoke_agent` root span is an agent run that makes
 * a turn, tool-less agent runs form one task per agent, and Agent health shows a reading from 10
 * turns marked low confidence. Off, everything reads as before.
 *
 * A core switch (ADR-0004), off by default. Without the edition's flags port it is one switch for
 * the deployment, read from the configuration (or `experimentalFeatures` in the open-source
 * edition); with it, the edition decides it for the project (`featureEnabled`). It lives in the
 * platform layer because ingest and the turn ledger read it too; the readings call it through
 * `readings/trace-signals/tool-run-insights.ts`, which keeps upstream's names.
 */
export const TOOL_RUN_INSIGHTS_FLAG = "toolRunInsights" as const;

/** Whether tool-run insights are on for this subject (a project, at least). Never throws: a failed decision is off. */
export function toolRunInsightsOn(
  subject: FlagSubject,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled(TOOL_RUN_INSIGHTS_FLAG, subject, deps);
}
