import type { DrainStep, Registration } from "@/lib/contracts/registry";
import { createBackgroundObservability } from "@/lib/jobs/observability";
import { deliverAlerts } from "@/lib/views/alerts/deliver";
import { evaluateAlerts } from "@/lib/views/alerts/evaluate";
import { slackNotifier } from "@/lib/views/alerts/slack";
import { pruneAlertEvents } from "@/lib/views/alerts/store";

type TrackProjectEvent = ReturnType<typeof createBackgroundObservability>["trackProjectEvent"];

export interface AlertsStepDeps {
  evaluate: () => ReturnType<typeof evaluateAlerts>;
  deliver: () => ReturnType<typeof deliverAlerts>;
  track: TrackProjectEvent;
}

const defaultDeps: AlertsStepDeps = {
  evaluate: () => evaluateAlerts(),
  deliver: () => deliverAlerts(slackNotifier()),
  track: createBackgroundObservability().trackProjectEvent,
};

/** Each tick: evaluate the due rules, then send what is pending. */
export function alertsStep(deps: AlertsStepDeps = defaultDeps): DrainStep {
  // One event per broken rule and process: a tick is a minute.
  const reported = new Set<string>();
  return {
    name: "alerts_evaluate",
    phase: "before",
    run: async () => {
      const { evaluated, failed, skipped, changes } = await deps.evaluate();
      for (const change of changes) {
        if (!change.notice) continue;
        await deps.track(
          change.notice === "fire" ? "feature.alerts.fired" : "feature.alerts.recovered",
          change.projectId,
          { project_id: change.projectId, rule_id: change.ruleId, metric: change.metric },
        );
      }
      for (const { projectId, ruleId } of skipped) {
        if (reported.has(ruleId)) continue;
        reported.add(ruleId);
        await deps.track("feature.alerts.skipped", projectId, {
          project_id: projectId,
          rule_id: ruleId,
          reason: "malformed_query",
        });
      }
      const { sent, retrying, expired, failures } = await deps.deliver();
      for (const { projectId, ruleId, attempts } of failures) {
        await deps.track("feature.alerts.delivery_failed", projectId, {
          project_id: projectId,
          rule_id: ruleId,
          attempts,
        });
      }
      return {
        alertsEvaluated: evaluated,
        alertsFailed: failed,
        alertsSkipped: skipped.length,
        alertChanges: changes.length,
        alertMessagesSent: sent,
        alertMessagesRetrying: retrying,
        alertMessagesExpired: expired,
        alertMessagesFailed: failures.length,
      };
    },
  };
}

/**
 * One bounded batch of the history past 90 days each tick. The history is the alerts' own log and
 * outbox, not telemetry, so it expires whatever `DATA_RETENTION_ENABLED` says (no `retentionOnly`).
 */
export function alertEventsPruneStep(
  prune: () => Promise<number> = () => pruneAlertEvents(),
): DrainStep {
  return {
    name: "alert_events_prune",
    phase: "after",
    run: async () => ({ alertEventsPruned: await prune() }),
  };
}

export const alertsRegistration: Registration = {
  drainSteps: [alertsStep(), alertEventsPruneStep()],
};
