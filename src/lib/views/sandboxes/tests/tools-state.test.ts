import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowedToolModes,
  canPin,
  defaultToolMode,
  manifestTools,
  toolBadge,
  toolModesFor,
  toolsParamOverrides,
} from "../tools-state";

/** The playground's tool rules: modes per hint, the run's toolModes and tools edits, and the card badge. */

const SANDBOX = {
  params: [
    { name: "model", kind: "model", default: "anthropic/claude-sonnet-5-5" },
    {
      name: "tools",
      kind: "tools",
      default: [
        { name: "searchDocs", description: "Search the docs", hint: "readOnly" },
        { name: "createTicket", description: "Open a ticket", hint: "sideEffect" },
        { name: "deploy", description: "Deploy", hint: "sideEffect", allowReal: true },
        { name: "delegate", description: "Ask a sub-agent", opaque: true },
      ],
    },
  ],
};

test("manifest tools carry their hint, allowReal, opaque and param", () => {
  const tools = manifestTools(SANDBOX);
  assert.deepEqual(
    tools.map((t) => [t.name, t.hint, t.allowReal ?? false, t.opaque ?? false, t.param]),
    [
      ["searchDocs", "readOnly", false, false, "tools"],
      ["createTicket", "sideEffect", false, false, "tools"],
      ["deploy", "sideEffect", true, false, "tools"],
      ["delegate", "none", false, true, "tools"],
    ],
  );
  assert.deepEqual(tools.map(defaultToolMode), ["real", "fake", "fake", "confirm"]);
});

test("a sideEffect tool offers real only when the manifest allows it", () => {
  const [search, ticket, deploy] = manifestTools(SANDBOX);
  assert.deepEqual(allowedToolModes(search!), ["real", "fake", "confirm"]);
  assert.deepEqual(allowedToolModes(ticket!), ["fake", "confirm"]);
  assert.deepEqual(allowedToolModes(deploy!), ["real", "fake", "confirm"]);
});

test("a run sends only changed, allowed modes, and a changed tools param lists every tool (the SDK drops a tool left out)", () => {
  const tools = manifestTools(SANDBOX);
  assert.deepEqual(
    toolModesFor(tools, {
      searchDocs: { mode: "real" },
      createTicket: { mode: "real" },
      delegate: { mode: "fake" },
    }),
    { delegate: "fake" },
  );
  assert.deepEqual(
    toolsParamOverrides(tools, {
      searchDocs: { description: "Search the docs" },
      createTicket: { description: "File a ticket" },
      deploy: { enabled: false },
    }),
    {
      tools: [
        { name: "searchDocs" },
        { name: "createTicket", description: "File a ticket" },
        { name: "deploy", enabled: false },
        { name: "delegate" },
      ],
    },
  );
  assert.deepEqual(toolsParamOverrides(tools, {}), {});
});

test("the badge says how each call was answered", () => {
  assert.equal(toolBadge({ mode: "real", done: true }), "real");
  assert.equal(toolBadge({ mode: "fake", done: true, fakeSource: "recorded" }), "fake·recorded");
  assert.equal(toolBadge({ mode: "fake", done: true, fakeSource: "generated" }), "fake·generated");
  assert.equal(toolBadge({ mode: "fake", done: true, fakeSource: "pinned" }), "fake·pinned");
  assert.equal(toolBadge({ mode: "confirm", done: true, confirmDecision: "approve" }), "confirmed");
  assert.equal(toolBadge({ mode: "confirm", done: true, confirmDecision: "edit" }), "confirmed");
  assert.equal(
    toolBadge({ mode: "confirm", done: true, confirmDecision: "fake", fakeSource: "pinned" }),
    "fake·pinned",
  );
  assert.equal(toolBadge({ mode: "confirm", done: true, confirmDecision: "reject" }), "rejected");
  assert.equal(toolBadge({ mode: "confirm", done: false }), "awaiting review");
  assert.equal(toolBadge({ mode: "real", done: false }), "pending");
  assert.equal(canPin({ mode: "fake", done: true, fakeSource: "generated" }), true);
  assert.equal(canPin({ mode: "fake", done: true, fakeSource: "pinned" }), false);
  assert.equal(canPin({ mode: "fake", done: true, fakeSource: "generated", isError: true }), false);
});
