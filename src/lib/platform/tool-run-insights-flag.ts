import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";

/**
 * `FF_TOOL_RUN_INSIGHTS`: tool-run insights (ratel-cloud RC-725 and its follow-ups, upstream's
 * `cloud-tool-run-insights`). On, Tasks mine small projects (a floor of three runs), a tool-only
 * run reads a derived ask in Intents, an OTel `invoke_agent` root span is an agent run that makes
 * a turn, tool-less agent runs form one task per agent, and Agent health shows a reading from 10
 * turns marked low confidence. Off, everything reads as before.
 *
 * One switch for the deployment (or `RATEL_EXPERIMENTAL_FEATURES` in the open-source edition),
 * read from the environment and off by default. Upstream decides it per project and organization
 * through its flag service. It lives in the platform layer because ingest and the turn ledger read
 * it too; the readings call it through `readings/trace-signals/tool-run-insights.ts`, which keeps
 * upstream's names.
 */
export const TOOL_RUN_INSIGHTS_FLAG = "FF_TOOL_RUN_INSIGHTS" as const;

type Env = Record<string, string | undefined>;

/** Whether tool-run insights are on for this deployment. Reads the environment; never throws. */
export function toolRunInsightsOn(env: Env = process.env): boolean {
  return experimentalFeatureEnabled(TOOL_RUN_INSIGHTS_FLAG, env);
}
