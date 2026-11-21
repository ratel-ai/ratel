import { jobKindOfAsk } from "@/lib/jobs/job-ask";
import type { TurnAskText } from "@/lib/readings/topics/asks";
import { agentStepId, agentTaskName } from "@/lib/readings/trace-signals/workflows/agent-tasks";

/**
 * Agent-run asks (RC-801, flag `cloud-tool-run-insights`). A backend job's run
 * carries the job's ask (`jobAsk`, `lib/jobs/job-ask.ts`). Since RC-834 that
 * is the job in words with its allowlisted ids ("Draft a fix (fixId f-9)");
 * a stored run before it carries a machine ask, `<job kind> for project
 * <uuid>` and then the JSON payload. Either way the ids differ per run, so
 * the runs of one job kind are distinct asks that may not group. Such an ask
 * reads as the job as its task is named ("draft_fix" reads "Draft fix"), so
 * the runs of one job kind, old and new, are one ask. The source `derived`
 * marks it as not a person's words. The raw ask stays on the span. Pure and
 * deterministic.
 */

/** The job in words when `text` is a job's ask, old or new; null for any other ask. */
export function agentRunAsk(text: string): string | null {
  const kind = jobKindOfAsk(text);
  return kind ? agentTaskName(agentStepId(kind)) : null;
}

/** The asks that are a job's ask, each as its derived ask. */
export function agentRunAsks(
  asks: ReadonlyMap<string, { readonly text: string }>,
): Map<string, TurnAskText> {
  const out = new Map<string, TurnAskText>();
  for (const [turnId, ask] of asks) {
    const text = agentRunAsk(ask.text);
    if (text) out.set(turnId, { text, source: "derived" });
  }
  return out;
}
