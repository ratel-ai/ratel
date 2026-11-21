import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SpanIOPanel } from "@/components/console/traces/SpanIOPanel";
import type { TraceSpanView } from "@/lib/synthesis/traces/view";

/** RC-501: the span pane's callout and the child model call's content for a wrapper step. */

const WRAPPER = {
  spanId: "w1",
  spanClass: "agent",
  name: "agent_step pm-agent",
  attributes: {},
  scopeName: null,
  attrsTruncated: false,
} as unknown as TraceSpanView;
const CHILD = {
  spanId: "m1",
  spanClass: "llm_call",
  attributes: {
    "gen_ai.input.messages":
      '[{"role":"user","parts":[{"type":"text","content":"Weather in Rome?"}]}]',
    "gen_ai.output.messages": '[{"role":"assistant","parts":[{"type":"text","content":"Sunny."}]}]',
  },
};
const CAPTURED = /isn(?:&#x27;|')t captured/;

function render(props: Partial<Parameters<typeof SpanIOPanel>[0]>): string {
  return renderToStaticMarkup(
    createElement(SpanIOPanel, {
      span: WRAPPER,
      raw: null,
      rawState: "ready",
      payload: null,
      ...props,
    }),
  );
}

test("a wrapper step shows its child model call's messages and offers to open that call", () => {
  const html = render({ descendants: [CHILD], turnHasContent: true, onSelectSpan: () => {} });
  assert.match(html, /data-span-io-source="child"/);
  assert.match(html, /Weather in Rome\?/);
  assert.match(html, /Open that model call/);
  assert.doesNotMatch(html, CAPTURED);
});

test("a step with no content of its own says so when the turn has content, and says isn't captured only when the turn has none", () => {
  const ownless = render({ turnHasContent: true });
  assert.match(ownless, /This step has no messages of its own/);
  assert.doesNotMatch(ownless, CAPTURED);
  assert.match(render({ turnHasContent: false }), CAPTURED);
});
