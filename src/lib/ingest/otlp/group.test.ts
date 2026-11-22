import assert from "node:assert/strict";
import { test } from "node:test";
import { categorize } from "@/lib/ingest/categorize";
import {
  agentOnlyTrace,
  CLAUDE_SDK_TRACE,
  claudeAgentSdkTrace,
  LANGGRAPH_TRACE,
  langGraphTrace,
} from "./agent-span-fixtures";
import { groupSpans, modelCallTraceIds } from "./group";
import { toCloudEvent } from "./reconstruct";
import type { AttrMap, DecodedEvent, DecodedSpan } from "./types";

/** Minimal DecodedSpan builder for grouping tests. */
function span(p: Partial<DecodedSpan> & { spanId: string }): DecodedSpan {
  return {
    traceId: "trace-1",
    parentSpanId: null,
    name: "",
    kind: 3,
    startUnixMs: 1_000,
    endUnixMs: 1_100,
    attributes: {},
    events: [],
    statusCode: 0,
    resourceAttributes: {},
    scopeName: null,
    ...p,
  };
}

function anchor(spanId: string, attrs: AttrMap = {}, events: DecodedEvent[] = []): DecodedSpan {
  return span({
    spanId,
    name: "chat gpt-5.5",
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-5.5", ...attrs },
    events,
  });
}

function tool(spanId: string, parentSpanId: string | null, traceId = "trace-1"): DecodedSpan {
  return span({
    spanId,
    parentSpanId,
    traceId,
    name: "execute_tool",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "search_docs" },
  });
}

const detailsEvent: DecodedEvent = {
  name: "gen_ai.client.inference.operation.details",
  timeUnixMs: 1_000,
  attributes: { "gen_ai.input.messages": [] },
};

test("single anchor → one call, details event attached", () => {
  const calls = groupSpans([anchor("a1", {}, [detailsEvent])]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].anchor.spanId, "a1");
  assert.ok(calls[0].detailsEvent);
  assert.equal(calls[0].toolSpans.length, 0);
});

test("anchor without the details event → detailsEvent null", () => {
  const calls = groupSpans([anchor("a1")]);
  assert.equal(calls[0].detailsEvent, null);
});

test("multiple anchors in one export → one call each, in order", () => {
  const calls = groupSpans([anchor("a1"), anchor("a2"), anchor("a3")]);
  assert.deepEqual(
    calls.map((c) => c.anchor.spanId),
    ["a1", "a2", "a3"],
  );
});

test("execute_tool span attaches to its parent anchor; ratel.search is ignored", () => {
  const search = span({
    spanId: "s1",
    parentSpanId: "a1",
    name: "ratel.search",
    attributes: { "ratel.search.target": "tool" },
  });
  const calls = groupSpans([anchor("a1"), tool("t1", "a1"), search]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolSpans.length, 1);
  assert.equal(calls[0].toolSpans[0].spanId, "t1");
});

test("tool attaches via single-anchor fallback when its parent is the (non-anchor) root", () => {
  const root = span({ spanId: "root", name: "agent turn", attributes: {} });
  const calls = groupSpans([root, anchor("a1", {}, []), tool("t1", "root")]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolSpans.length, 1);
});

test("tool walks the parent chain up to the owning anchor across intermediates", () => {
  // t1 → mid → a1 (anchor). Two anchors in the trace, so the single-anchor
  // fallback can't apply — the chain walk must find a1.
  const mid = span({ spanId: "mid", parentSpanId: "a1", name: "step" });
  const calls = groupSpans([anchor("a1"), anchor("a2"), mid, tool("t1", "mid")]);
  const a1 = calls.find((c) => c.anchor.spanId === "a1")!;
  const a2 = calls.find((c) => c.anchor.spanId === "a2")!;
  assert.equal(a1.toolSpans.length, 1);
  assert.equal(a2.toolSpans.length, 0);
});

test("batch spanning two traces keeps calls and tools separated", () => {
  const calls = groupSpans([
    anchor("a1"), // trace-1
    span({
      spanId: "a2",
      traceId: "trace-2",
      name: "chat",
      attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "m" },
    }),
    tool("t1", "a1", "trace-1"),
    tool("t2", "a2", "trace-2"),
  ]);
  const c1 = calls.find((c) => c.anchor.spanId === "a1")!;
  const c2 = calls.find((c) => c.anchor.spanId === "a2")!;
  assert.equal(c1.toolSpans.length, 1);
  assert.equal(c1.toolSpans[0].spanId, "t1");
  assert.equal(c2.toolSpans.length, 1);
  assert.equal(c2.toolSpans[0].spanId, "t2");
});

test("anchor detected by usage when operation.name is absent", () => {
  const s = span({
    spanId: "a1",
    name: "llm",
    attributes: { "gen_ai.usage.input_tokens": 100 },
  });
  const calls = groupSpans([s]);
  assert.equal(calls.length, 1);
});

test("execute_tool is never treated as an anchor", () => {
  const calls = groupSpans([tool("t1", null)]);
  assert.equal(calls.length, 0);
});

test("a ratel.* span alone yields no calls", () => {
  const search = span({
    spanId: "s1",
    name: "ratel.search",
    attributes: { "ratel.search.target": "tool", "ratel.search.hit_count": 3 },
  });
  assert.equal(groupSpans([search]).length, 0);
});

/** Flag on: dedupe agent wrappers against the traces this batch shows model calls for. */
function dedupe(spans: DecodedSpan[], stored: string[] = []) {
  return { modelCallTraces: new Set([...modelCallTraceIds(spans), ...stored]) };
}

test("flag on: a LangGraph invoke_agent root with summed usage is not a call", () => {
  const spans = langGraphTrace();
  const calls = groupSpans(spans, dedupe(spans));
  assert.deepEqual(
    calls.map((c) => c.anchor.spanId),
    ["1000000000000002", "1000000000000003"],
  );
  // Equal start times in the fixture: the first-listed chat owns the root's tools.
  assert.deepEqual(
    calls.map((c) => c.toolSpans.length),
    [2, 0],
  );
});

/** Offset each span's start (and end) by `ms` milliseconds, keyed by span id. */
function timed(spans: DecodedSpan[], offsets: Record<string, number>): DecodedSpan[] {
  return spans.map((s) => {
    const ms = offsets[s.spanId] ?? 0;
    return { ...s, startUnixMs: s.startUnixMs + ms, endUnixMs: s.startUnixMs + ms + 500 };
  });
}

/** LangGraph run: chat → search → chat → fetch, the tools parented on the root. */
function langGraphTimeline(): DecodedSpan[] {
  return timed(langGraphTrace(), {
    "1000000000000002": 1_000,
    "1000000000000004": 2_000,
    "1000000000000003": 3_000,
    "1000000000000005": 4_000,
  });
}

function toolNamesPerCall(spans: DecodedSpan[], flagOn: boolean): string[][] {
  return groupSpans(spans, flagOn ? dedupe(spans) : undefined).map((c) =>
    Object.keys(categorize(toCloudEvent(c)).toolsByName),
  );
}

test("flag on: a root-parented tool lands on the chat that started last before it", () => {
  assert.deepEqual(toolNamesPerCall(langGraphTimeline(), true), [["search"], ["fetch"]]);
});

test("flag on: a root-parented tool that starts before every chat lands on the earliest chat", () => {
  const spans = timed(langGraphTrace(), {
    "1000000000000004": 500,
    "1000000000000002": 1_000,
    "1000000000000003": 3_000,
    "1000000000000005": 4_000,
  });
  assert.deepEqual(toolNamesPerCall(spans, true), [["search"], ["fetch"]]);
});

test("flag off: root-parented tools stay on the root, unchanged", () => {
  assert.deepEqual(toolNamesPerCall(langGraphTimeline(), false), [["search", "fetch"], [], []]);
});

test("flag on: content captured, a chat's tool count equals its requested tool calls", () => {
  const spans = langGraphTimeline().map((s) =>
    s.spanId === "1000000000000002"
      ? {
          ...s,
          attributes: {
            ...s.attributes,
            "gen_ai.output.messages": [
              {
                role: "assistant",
                parts: [{ type: "tool_call", id: "c1", name: "search", arguments: { q: "x" } }],
              },
            ],
          },
        }
      : s,
  );
  const calls = groupSpans(spans, dedupe(spans));
  assert.deepEqual(
    calls.map((c) => c.toolSpans.length),
    [1, 1],
  );
  const [first] = calls.map((c) => categorize(toCloudEvent(c)).toolsByName);
  assert.equal(first.search.calls, 1);
});

test("flag off: the LangGraph root stays an anchor and owns its tools", () => {
  const calls = groupSpans(langGraphTrace());
  assert.deepEqual(
    calls.map((c) => [c.anchor.spanId, c.toolSpans.length]),
    [
      ["1000000000000001", 2],
      ["1000000000000002", 0],
      ["1000000000000003", 0],
    ],
  );
});

test("flag on: a Claude Agent SDK root is not a call; its tool stays on its chat", () => {
  const spans = claudeAgentSdkTrace();
  const calls = groupSpans(spans, dedupe(spans));
  assert.deepEqual(
    calls.map((c) => [c.anchor.spanId, c.toolSpans.length]),
    [
      ["2000000000000002", 0],
      ["2000000000000003", 1],
    ],
  );
});

test("flag on: a Claude Agent SDK root-parented tool lands on the preceding chat; a chat child stays put", () => {
  const [root, ...rest] = claudeAgentSdkTrace();
  const rootTool: DecodedSpan = {
    ...rest[2],
    spanId: "2000000000000005",
    parentSpanId: root.spanId,
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "Task" },
  };
  const spans = timed([root, ...rest, rootTool], {
    "2000000000000002": 1_000,
    "2000000000000005": 2_000,
    "2000000000000003": 3_000,
    "2000000000000004": 3_500,
  });
  assert.deepEqual(toolNamesPerCall(spans, true), [["Task"], ["Read"]]);
  assert.deepEqual(toolNamesPerCall(spans, false), [["Task"], [], ["Read"]]);
});

test("flag off: the Claude Agent SDK root stays an anchor", () => {
  assert.equal(groupSpans(claudeAgentSdkTrace()).length, 3);
});

test("flag on: an agent span with no model call in its trace still counts", () => {
  const spans = agentOnlyTrace();
  const calls = groupSpans(spans, dedupe(spans));
  assert.deepEqual(
    calls.map((c) => [c.anchor.spanId, c.toolSpans.length]),
    [["3000000000000001", 1]],
  );
  const [alone] = spans;
  assert.equal(groupSpans([alone], dedupe([alone])).length, 1);
});

test("flag on: a root alone in its batch is not a call when storage has its model calls", () => {
  const [root] = langGraphTrace();
  assert.equal(groupSpans([root], dedupe([root], [LANGGRAPH_TRACE])).length, 0);
  assert.equal(groupSpans([root], dedupe([root], [CLAUDE_SDK_TRACE])).length, 1);
});

test("flag on: embeddings spans stay anchors", () => {
  const embed = span({
    spanId: "e1",
    name: "embeddings text-embedding-3-small",
    attributes: { "gen_ai.operation.name": "embeddings", "gen_ai.usage.input_tokens": 12 },
  });
  const spans = [embed, anchor("a1")];
  assert.deepEqual(
    groupSpans(spans, dedupe(spans)).map((c) => c.anchor.spanId),
    ["e1", "a1"],
  );
});

/** An `embeddings` span in `base`'s trace, started at `base`'s start. */
function embeddingsLike(base: DecodedSpan, spanId: string): DecodedSpan {
  return {
    ...base,
    spanId,
    name: "embeddings text-embedding-3-small",
    attributes: {
      "gen_ai.operation.name": "embeddings",
      "gen_ai.request.model": "text-embedding-3-small",
      "gen_ai.usage.input_tokens": 12,
    },
  };
}

test("flag on: an embeddings span does not dedupe an agent-only trace's wrapper", () => {
  const [root, ...rest] = agentOnlyTrace();
  const spans = [root, ...rest, embeddingsLike(root, "3000000000000003")];
  const calls = groupSpans(spans, dedupe(spans));
  assert.deepEqual(
    calls.map((c) => [c.anchor.spanId, c.toolSpans.length]),
    [
      ["3000000000000001", 1],
      ["3000000000000003", 0],
    ],
  );
  assert.equal(calls[0].anchor.attributes["gen_ai.usage.input_tokens"], 300);
});

test("flag on: a root-parented tool skips an embeddings span and lands on the preceding chat", () => {
  const [root, chat, ...rest] = langGraphTrace();
  const embed = { ...embeddingsLike(chat, "1000000000000006"), parentSpanId: root.spanId };
  const spans = timed([root, chat, ...rest, embed], {
    "1000000000000002": 1_000,
    "1000000000000006": 1_500,
    "1000000000000004": 2_000,
    "1000000000000003": 3_000,
    "1000000000000005": 4_000,
  });
  assert.deepEqual(toolNamesPerCall(spans, true), [["search"], ["fetch"], []]);
});
