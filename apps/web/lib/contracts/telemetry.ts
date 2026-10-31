/**
 * Product events and exception reports. The open-source edition writes log lines; the Cloud
 * edition sends them to its analytics. Both are best-effort: a port implementation must never
 * throw into the caller, and must never be handed user content (asks, prompts, labels), only
 * names, ids and numbers.
 */
export type TelemetryContext = {
  /** Who or what acted: a user id, `project:<id>`, `organization:<id>` or `system:<name>`. */
  distinctId: string;
  orgId?: string;
  projectId?: string;
};

export type TelemetryPort = {
  trackEvent(
    name: string,
    context: TelemetryContext,
    properties?: Record<string, unknown>,
  ): Promise<void>;
  reportException(error: unknown, distinctId: string, properties?: Record<string, unknown>): void;
};
