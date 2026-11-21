import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOL_RUN_INSIGHTS_FLAG, toolRunInsightsOn } from "@/lib/platform/tool-run-insights-flag";

test("tool-run insights are off with nothing set", () => {
  assert.equal(toolRunInsightsOn({}), false);
});

test("FF_TOOL_RUN_INSIGHTS turns them on, and only a true value does", () => {
  assert.equal(TOOL_RUN_INSIGHTS_FLAG, "FF_TOOL_RUN_INSIGHTS");
  assert.equal(toolRunInsightsOn({ FF_TOOL_RUN_INSIGHTS: "1" }), true);
  assert.equal(toolRunInsightsOn({ FF_TOOL_RUN_INSIGHTS: "true" }), true);
  assert.equal(toolRunInsightsOn({ FF_TOOL_RUN_INSIGHTS: "0" }), false);
  assert.equal(toolRunInsightsOn({ FF_TOOL_RUN_INSIGHTS: "yes" }), false);
});

test("another experimental switch does not turn them on", () => {
  assert.equal(toolRunInsightsOn({ FF_MCP_APPS: "1" }), false);
});
