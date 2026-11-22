import type { FakeAlerts } from "@/lib/views/sandboxes/fakes/ports/fake-alerts";

/**
 * The cap alert: one error log line (an operator's monitor on
 * `sandbox_fake_cap_reached` counts it) and one `sandbox_fake_cap_reached` server
 * event. The gateway passes its own logger and event capture, so this module
 * imports neither.
 *
 * Owned (ADR-0030): upstream's comment named the Cloud monitor and analytics vendor.
 */

export const CAP_REACHED_EVENT = "sandbox_fake_cap_reached";

export interface AlertLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

export type CaptureEvent = (
  distinctId: string,
  event: string,
  properties: Record<string, unknown>,
) => void;

export function createFakeAlerts(logger: AlertLogger, capture: CaptureEvent | null): FakeAlerts {
  return {
    capReached({ projectId, organizationId, day, runId }) {
      logger.error(
        {
          event: CAP_REACHED_EVENT,
          project_id: projectId,
          organization_id: organizationId,
          day,
          run_id: runId,
        },
        "sandbox fake cap reached",
      );
      try {
        capture?.(`project:${projectId}`, CAP_REACHED_EVENT, {
          project_id: projectId,
          ...(organizationId ? { org_id: organizationId } : {}),
          day,
        });
      } catch (err) {
        logger.error(
          { err: { message: (err as Error).message }, project_id: projectId },
          "sandbox fake cap event failed",
        );
      }
    },
  };
}
