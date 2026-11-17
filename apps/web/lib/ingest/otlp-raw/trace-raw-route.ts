import type { AttrMap, DecodedEvent } from "@/lib/ingest/otlp/types";
import { traceOtlpJson } from "./otlp-json";
import { type RawViewPolicy, redactAttributes, redactEvent } from "./redact";
import type { TraceRawRequests, TraceRawSpans } from "./trace-read";

/** One span's raw content for the span pane: what the stored `otel_spans` row may have stripped. */
export interface RawSpanView {
  spanId: string;
  attributes: AttrMap;
  resourceAttributes: AttrMap;
  events: DecodedEvent[];
  scopeName: string | null;
}

export type TraceRawRouteResponse =
  | {
      ok: true;
      spans: RawSpanView[];
      exports: number;
      truncated: boolean;
      contentWithheld: boolean;
    }
  | { ok: false; message: string };

export interface TraceRawRouteDeps {
  getSession(): Promise<{ userId: string; externalId: string } | null>;
  findProject(projectId: string, userId: string): Promise<{ projectId: string } | null>;
  flagEnabled(projectId: string, actor: string): Promise<boolean>;
  /** The content kill switch (`cloud-payload-content`): raw spans carry message content. */
  contentEnabled(projectId: string, actor: string): Promise<boolean>;
  /** The project's `session_replay_settings.read_content`: off, content keys are left out. */
  readContent(projectId: string): Promise<boolean>;
  loadRaw(projectId: string, traceId: string): Promise<TraceRawSpans>;
  /** The stored export requests, for the lossless download. */
  loadRawOtlp(projectId: string, traceId: string): Promise<TraceRawRequests>;
  setLogContext(fields: Record<string, unknown>): void;
}

const TRACE_ID = /^[0-9a-f]{32}$/;
const NOT_FOUND = "This run isn't available.";

/**
 * GET one run's raw spans from `otlp_raw_exports` (RC-412), for a member of
 * its project with `cloud-trace-views-v3` on. `?format=otlp` answers the
 * whole trace as an OTLP/JSON file. A project without raw capture gets no
 * spans, not an error. Raw spans carry message content, so with the content
 * kill switch off the route reads nothing: no spans, and no download. With
 * the project's `read_content` off, both leave content keys out. Both always
 * redact credentials (`redact.ts`). A download cut at the read bounds is
 * marked partial. A read; no product event.
 */
export async function traceRawResponse(
  request: Request,
  params: { projectId: string; traceId: string },
  deps: TraceRawRouteDeps,
): Promise<Response> {
  const session = await deps.getSession();
  if (!session)
    return Response.json({ ok: false, message: "Sign in to see this run." }, { status: 401 });
  const scope = await deps.findProject(params.projectId, session.userId);
  const traceId = params.traceId.toLowerCase();
  if (
    !scope ||
    !TRACE_ID.test(traceId) ||
    !(await deps.flagEnabled(scope.projectId, session.externalId))
  ) {
    return Response.json({ ok: false, message: NOT_FOUND }, { status: 404 });
  }
  const format = new URL(request.url).searchParams.get("format") === "otlp" ? "otlp" : "spans";
  deps.setLogContext({ project_id: scope.projectId, trace_id: traceId, format });
  if (!(await deps.contentEnabled(scope.projectId, session.externalId))) {
    deps.setLogContext({ raw_content_off: true });
    if (format === "otlp") return Response.json({ ok: false, message: NOT_FOUND }, { status: 404 });
    const empty: TraceRawRouteResponse = {
      ok: true,
      exports: 0,
      truncated: false,
      contentWithheld: true,
      spans: [],
    };
    return Response.json(empty, { headers: { "cache-control": "no-store" } });
  }

  const policy: RawViewPolicy = { readContent: await deps.readContent(scope.projectId) };
  deps.setLogContext({ raw_read_content: policy.readContent });
  if (format === "otlp") {
    const raw = await deps.loadRawOtlp(scope.projectId, traceId);
    deps.setLogContext({
      raw_exports: raw.exports,
      raw_truncated: raw.truncated,
      raw_undecodable: raw.undecodable,
    });
    // Cut at the read bounds, or an export that did not decode: spans are missing.
    const partial = raw.truncated || raw.undecodable > 0;
    const name = `trace-${traceId}${partial ? ".partial" : ""}.otlp.json`;
    return new Response(JSON.stringify(traceOtlpJson(raw.requests, traceId, policy)), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
        ...(partial ? { "x-ratel-otlp-truncated": "true" } : {}),
      },
    });
  }
  const raw = await deps.loadRaw(scope.projectId, traceId);
  deps.setLogContext({
    raw_exports: raw.exports,
    raw_spans: raw.spans.length,
    raw_truncated: raw.truncated,
    raw_undecodable: raw.undecodable,
  });
  const body: TraceRawRouteResponse = {
    ok: true,
    exports: raw.exports,
    truncated: raw.truncated,
    contentWithheld: !policy.readContent,
    spans: raw.spans.map((span) => ({
      spanId: span.spanId,
      attributes: redactAttributes(span.attributes, policy),
      resourceAttributes: redactAttributes(span.resourceAttributes, policy),
      events: span.events.map((event) => redactEvent(event, policy)),
      scopeName: span.scopeName,
    })),
  };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
