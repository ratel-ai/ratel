import type { Instrumentation } from "next";

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
  /**
   * An uncaught server-side request error (the framework's `onRequestError`), Node runtime only.
   * `request.headers` are handed over so the edition can tie the error to its own analytics
   * identity (a cookie it set); they are for that only and must never be logged or sent on.
   * The path may carry a query string. Absent in the open-source edition: nothing is reported.
   */
  reportRequestError?(
    error: unknown,
    request: RequestErrorRequest,
    context: RequestErrorContext,
  ): Promise<void>;
  /**
   * Flush and close whatever the edition still buffers, within `timeoutMs`. Called once when the
   * process stops, from the instrumentation's shutdown, which runs in a separate module instance
   * from the routes: the edition must reach the client its routes created. Absent: nothing to flush.
   */
  shutdown?(timeoutMs: number): Promise<void>;
};

/** The request an uncaught error happened on, as the framework describes it. */
export type RequestErrorRequest = Parameters<Instrumentation.onRequestError>[1];

/** Where in the app the error happened: the route pattern and its kind. */
export type RequestErrorContext = Parameters<Instrumentation.onRequestError>[2];
