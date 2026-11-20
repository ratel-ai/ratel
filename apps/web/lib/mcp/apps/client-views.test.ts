import assert from "node:assert/strict";
import { test } from "node:test";
import { clientViews, declaresViews, VIEW_SESSION_PREFIX, viewSessionId } from "./client-views";

const ui = {
  extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
};
// What Claude Code 2.1.323 sends (captured on the local server, RW-56): no views.
const claudeCode = {
  roots: { listChanged: true },
  elicitation: { form: {}, url: {} },
  extensions: { "io.modelcontextprotocol/tasks": {} },
};

test("a client declares views with the MCP Apps extension and our MIME type", () => {
  assert.equal(declaresViews(ui), true);
  assert.equal(declaresViews(claudeCode), false);
  assert.equal(
    declaresViews({ extensions: { "io.modelcontextprotocol/ui": {} } }),
    false,
    "no MIME types: not ours",
  );
  assert.equal(declaresViews(undefined), false);
});

test("initialize from a client with views: it shows them, and gets a session id saying so", () => {
  assert.deepEqual(clientViews([{ method: "initialize", params: { capabilities: ui } }], null), {
    renders: true,
    issueSession: true,
  });
  assert.deepEqual(
    clientViews([{ method: "initialize", params: { capabilities: claudeCode } }], null),
    { renders: false, issueSession: false },
  );
});

test("a later request shows views when it brings that session id back, or says so in its own _meta", () => {
  const call = [
    { method: "tools/call", params: { name: "get_trace", _meta: { progressToken: 3 } } },
  ];
  assert.deepEqual(clientViews(call, viewSessionId()), { renders: true, issueSession: false });
  assert.deepEqual(clientViews(call, null), { renders: false, issueSession: false });
  assert.deepEqual(clientViews(call, "some-other-session"), {
    renders: false,
    issueSession: false,
  });
  const stateless = [
    {
      method: "tools/call",
      params: { _meta: { "io.modelcontextprotocol/clientCapabilities": ui } },
    },
  ];
  assert.deepEqual(clientViews(stateless, null), { renders: true, issueSession: false });
  const claudeCodeDiscover = [
    {
      method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/clientCapabilities": claudeCode } },
    },
  ];
  assert.deepEqual(clientViews(claudeCodeDiscover, null), { renders: false, issueSession: false });
});

test("session ids are unique and carry the prefix", () => {
  const a = viewSessionId();
  assert.ok(a.startsWith(VIEW_SESSION_PREFIX));
  assert.notEqual(a, viewSessionId());
});
