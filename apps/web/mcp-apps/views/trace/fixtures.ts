import type { TraceViewProps } from "@/lib/views/traces/trace-view-types";
import { withoutCapturedText } from "@/lib/views/traces/without-captured-text";
import { traceDetail } from "../../harness/data";
import { errorResult, okResult, type ViewFixtures } from "../../shell/types";
import trace from "./captured/trace.json";

/** The trace's root step, which titles it for a caller who may not read captured text (contentFreeTitle). */
const ROOT_STEP = "pm-agent";

/**
 * The result for an API key with content reading off: the open one through the
 * server's own withoutCapturedText (lib/mcp/operations/observability.ts get_trace).
 */
export const withheld = {
  data: { ...trace.data, contentWithheld: true },
  view: {
    kind: "trace",
    props: withoutCapturedText(trace.view.props as unknown as TraceViewProps, ROOT_STEP),
  },
};

/**
 * "get_trace" is captured from the local demo (pnpm mcp-apps:local): the
 * result with its `view`, the trace page's own props. "· withheld" is the same
 * trace as an API key with content reading off gets it. The others have no
 * `view` (a host that passed the text only) and read as the generic detail.
 */
const fixtures: ViewFixtures = {
  get_trace: {
    tool: "get_trace",
    input: { traceId: trace.data.traceId },
    result: okResult(trace.data, { view: trace.view }),
  },
  "get_trace · withheld": {
    tool: "get_trace",
    input: { traceId: withheld.data.traceId },
    result: okResult(withheld.data, { view: withheld.view }),
  },
  "get_trace · dense": {
    tool: "get_trace",
    result: okResult(traceDetail("0af7651916cd43dd8448eb211c80319c", 23, 40)),
  },
  "get_trace · empty": {
    tool: "get_trace",
    result: okResult({ traceId: "e3b0c44298fc1c149afbf4c8996fb924", spanCount: 0, spans: [] }),
  },
  "get_trace · not found": {
    tool: "get_trace",
    result: errorResult("not_found", "No trace found."),
  },
};

export default fixtures;
