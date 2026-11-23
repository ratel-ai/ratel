import assert from "node:assert/strict";
import { test } from "node:test";
import trace from "./captured/trace.json";
import { withheld } from "./fixtures";
import { readTraceView } from "./trace";

test("get_trace's view is read as the trace page's TraceView props; anything else falls back", () => {
  const props = readTraceView(trace);
  assert.equal(props?.traceId, trace.data.traceId);
  assert.ok((props?.waterfall.rows.length ?? 0) > 0);
  assert.equal(readTraceView({}), null, "a host that passed the text only");
  assert.equal(readTraceView({ view: { kind: "session_chat", props: trace.view.props } }), null);
  assert.equal(
    readTraceView({ view: { kind: "trace", props: { traceId: "x" } } }),
    null,
    "props without a waterfall",
  );
});

test("a trace without captured text carries no ask, payload content or message attributes", () => {
  const open = readTraceView(trace)!;
  const props = readTraceView(withheld)!;
  assert.notEqual(
    open.title,
    props.title,
    "the open trace is titled by its ask, the withheld one by its root step",
  );
  assert.equal(props.payloadContent, null);
  const text = JSON.stringify(props);
  assert.ok(!text.includes(open.title), "the ask does not appear anywhere");
  assert.ok(
    !/gen_ai\.(input|output)\.messages|gen_ai\.tool\.call\.(arguments|result)/.test(text),
    "no message or tool payload attributes",
  );
});
