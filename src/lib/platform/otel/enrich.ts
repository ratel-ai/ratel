import { type Attributes, type SpanContext, trace } from "@opentelemetry/api";
import { requestRootSpanFor } from "./self-time-processor";

export type SpanEnrichmentContext = {
  project_id?: string;
  org_id?: string;
  distinctId?: string;
};

type ActiveSpan = {
  spanContext?: () => SpanContext;
  setAttributes(attributes: Attributes): unknown;
};
type GetActiveSpan = () => ActiveSpan | undefined;
type GetRequestRootSpan = (activeSpan: ActiveSpan) => ActiveSpan | undefined;

export function annotateActiveSpan(
  context: SpanEnrichmentContext,
  getActiveSpan: GetActiveSpan = () => trace.getActiveSpan(),
  getRequestRootSpan: GetRequestRootSpan = defaultGetRequestRootSpan,
): void {
  const activeSpan = getActiveSpan();
  if (!activeSpan) return;
  // Land project/org context on the request root when one is tracked so it rides
  // the span the waterfall is read from, falling back to the active child span
  // otherwise. Any self-telemetry dashboard filtering these on non-root spans
  // will now undercount — a deliberate move, flagged for post-deploy dashboard
  // verification.
  const targetSpan = getRequestRootSpan(activeSpan) ?? activeSpan;

  const attributes: Attributes = {};
  if (context.project_id) {
    attributes["ratel.project_id"] = context.project_id;
  }
  if (context.org_id) attributes["ratel.org_id"] = context.org_id;
  if (context.distinctId) {
    attributes.distinctId = context.distinctId;
  }
  targetSpan.setAttributes(attributes);
}

function defaultGetRequestRootSpan(activeSpan: ActiveSpan): ActiveSpan | undefined {
  if (!activeSpan.spanContext) return undefined;
  return requestRootSpanFor({ spanContext: () => activeSpan.spanContext!() });
}
