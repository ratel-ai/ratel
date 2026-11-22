import type { Instrumentation } from "next";

/**
 * Product events, exception reports and model-call records. The open-source edition writes log
 * lines for the first two and nothing for model calls; the Cloud edition sends events to its
 * analytics and writes a priced spend line per model call. Both are best-effort: a port implementation must never
 * throw into the caller, and must never be handed user content (asks, prompts, labels), only
 * names, ids and numbers.
 */
export type TelemetryContext = {
  /** Who or what acted: a user id, `project:<id>`, `organization:<id>` or `system:<name>`. */
  distinctId: string;
  orgId?: string;
  projectId?: string;
};

/** `anthropic`, `openai`, or whatever an edition's own clients name. */
export type ModelProvider = string;

export type ModelCallOutcome = "ok" | "error" | "refused_budget" | "skipped_no_key";

/** Who pays for the call: Ratel's own analysis, or a customer's traffic through Ratel. */
export type ModelCallPayer = "ratel" | "customer";

export interface ModelCallMeta {
  provider: ModelProvider;
  model: string;
  /** What the call is for, snake_case: `eval_gate_replay`, `eval_gate_judge`. */
  feature: string;
  payer: ModelCallPayer;
  organizationId?: string | null;
  projectId?: string | null;
}

export interface ModelCallUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Prompt tokens read from the provider's cache (a subset of input). */
  cachedTokens?: number | null;
  /** Prompt tokens written to the provider's cache (a subset of input). */
  cacheWriteTokens?: number | null;
}

/**
 * One model call the core made, refused or skipped: ids, a model name, numbers and an outcome.
 * Never a prompt or an answer.
 */
export interface ModelCallRecord extends ModelCallMeta, ModelCallUsage {
  outcome: ModelCallOutcome;
  durationMs: number;
  /**
   * The thrown error. A recorder reads its stable type (`stableErrorType` in `error-type.ts`)
   * and nothing else: the message can hold a provider's text, and the bundle mangles class names.
   */
  error?: unknown;
  /** How many calls the record stands for: refusals in one simulation are one record with their count. */
  calls?: number;
}

/** The core's log context when the call was recorded: the request or the job it belongs to. */
export type ModelCallLogContext = {
  requestId?: string;
  project_id?: string;
  org_id?: string;
  org_slug?: string;
  project_path?: string;
  distinctId?: string;
  mcp_operation?: string;
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
  /**
   * An edition that accounts for model spend takes every model call the core records here and
   * writes its own line (it prices the call). Absent, the core writes nothing: a recorded call
   * only runs. Must not throw; the core guards the call either way.
   */
  recordModelCall?(record: ModelCallRecord, context: ModelCallLogContext): void;
};

/** The request an uncaught error happened on, as the framework describes it. */
export type RequestErrorRequest = Parameters<Instrumentation.onRequestError>[1];

/** Where in the app the error happened: the route pattern and its kind. */
export type RequestErrorContext = Parameters<Instrumentation.onRequestError>[2];
