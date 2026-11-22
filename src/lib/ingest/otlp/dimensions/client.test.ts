import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveSpanDimensions } from "@/lib/ingest/otlp/dimensions";
import { indexSpans } from "../attr-resolve";
import type { AttrMap, DecodedSpan } from "../types";
import {
  type ClientFacts,
  harnessOf,
  NO_CLIENT_FACTS,
  sessionsToLookUp,
  userAgentProduct,
} from "./client";

const TRACE = "a".repeat(32);
const HTTP = "1".repeat(16);
const MCP = "2".repeat(16);
const INIT = "3".repeat(16);
const OTHER = "4".repeat(16);
const SERVER = 2;

function span(
  spanId: string,
  over: Partial<DecodedSpan> & { attributes?: AttrMap } = {},
): DecodedSpan {
  return {
    traceId: TRACE,
    spanId,
    parentSpanId: null,
    name: "span",
    kind: 1,
    startUnixMs: 10,
    endUnixMs: 20,
    attributes: {},
    events: [],
    statusCode: 0,
    resourceAttributes: { "service.name": "weather-mcp" },
    scopeName: null,
    ...over,
  };
}

function httpServer(attributes: AttrMap, over: Partial<DecodedSpan> = {}): DecodedSpan {
  return span(HTTP, {
    name: "POST /mcp",
    kind: SERVER,
    startUnixMs: 0,
    endUnixMs: 100,
    attributes: { "http.request.method": "POST", ...attributes },
    ...over,
  });
}

function mcpCall(attributes: AttrMap = {}, over: Partial<DecodedSpan> = {}): DecodedSpan {
  return span(MCP, {
    name: "tools/call get-weather",
    kind: SERVER,
    parentSpanId: HTTP,
    attributes: { "mcp.method.name": "tools/call", ...attributes },
    ...over,
  });
}

function initialize(attributes: AttrMap = {}, over: Partial<DecodedSpan> = {}): DecodedSpan {
  return span(INIT, {
    name: "initialize",
    kind: SERVER,
    attributes: { "mcp.method.name": "initialize", ...attributes },
    ...over,
  });
}

function clientOf(
  spans: DecodedSpan[],
  id: string,
  stored?: ReadonlyMap<string, ClientFacts>,
): ClientFacts {
  return deriveSpanDimensions(spans, indexSpans(spans), stored).get(id)!.client;
}

const facts = (over: Partial<ClientFacts>): ClientFacts => ({ ...NO_CLIENT_FACTS, ...over });

test("harnessOf maps client names and User-Agent products to a normalized id", () => {
  const cases: Array<[string, string]> = [
    ["claude-code", "claude-code"],
    ["Claude Code", "claude-code"],
    ["claude-ai", "other"],
    ["codex-mcp-client", "codex"],
    ["codex_cli_rs", "codex"],
    ["opencode", "opencode"],
    ["Cursor", "cursor"],
    ["cursor-vscode", "cursor"],
    ["Visual Studio Code", "vscode"],
    ["vscode-copilot", "vscode"],
    ["python-httpx", "other"],
  ];
  for (const [raw, id] of cases) assert.equal(harnessOf(raw), id, raw);
});

test("userAgentProduct reads the first product token and its version", () => {
  assert.deepEqual(userAgentProduct("claude-code/2.1.3 (external, cli)"), {
    name: "claude-code",
    version: "2.1.3",
  });
  assert.deepEqual(userAgentProduct("Cursor/1.7.0"), { name: "Cursor", version: "1.7.0" });
  assert.deepEqual(userAgentProduct("opencode"), { name: "opencode", version: null });
  assert.equal(userAgentProduct("   "), null);
  assert.equal(userAgentProduct(undefined), null);
});

test("a tools/call under an HTTP server span takes the harness and client IP from the HTTP span", () => {
  const spans = [
    httpServer({
      "user_agent.original": "claude-code/2.1.3 (external, cli)",
      "client.address": "203.0.113.7",
    }),
    mcpCall(),
  ];
  assert.deepEqual(
    clientOf(spans, MCP),
    facts({
      harness: "claude-code",
      harnessRaw: "claude-code",
      harnessVersion: "2.1.3",
      harnessSource: "heuristic",
      clientIp: "203.0.113.7",
      mcpTransport: "http",
    }),
  );
});

test("older HTTP semconv keys are read too: http.user_agent, net.sock.peer.addr, net.peer.ip", () => {
  const sock = [
    httpServer({
      "http.method": "POST",
      "http.user_agent": "Cursor/1.7.0",
      "net.sock.peer.addr": "198.51.100.4",
      "net.peer.ip": "10.0.0.1",
    }),
    mcpCall(),
  ];
  assert.deepEqual(
    clientOf(sock, MCP),
    facts({
      harness: "cursor",
      harnessRaw: "Cursor",
      harnessVersion: "1.7.0",
      harnessSource: "heuristic",
      clientIp: "198.51.100.4",
      mcpTransport: "http",
    }),
  );
  const peer = [httpServer({ "http.method": "POST", "net.peer.ip": "198.51.100.5" }), mcpCall()];
  assert.equal(clientOf(peer, MCP).clientIp, "198.51.100.5");
});

test("the HTTP span of the same trace counts when the MCP span hangs under the caller's span instead", () => {
  const spans = [
    httpServer({ "user_agent.original": "opencode/0.9.1", "client.address": "203.0.113.9" }),
    mcpCall({}, { parentSpanId: "9".repeat(16) }),
  ];
  assert.deepEqual(
    clientOf(spans, MCP),
    facts({
      harness: "opencode",
      harnessRaw: "opencode",
      harnessVersion: "0.9.1",
      harnessSource: "heuristic",
      clientIp: "203.0.113.9",
      mcpTransport: "http",
    }),
  );
});

test("an HTTP span that does not enclose the MCP span in time is another request", () => {
  const spans = [
    httpServer({ "user_agent.original": "opencode/0.9.1" }, { startUnixMs: 200, endUnixMs: 300 }),
    mcpCall({}, { parentSpanId: null }),
  ];
  assert.deepEqual(clientOf(spans, MCP), NO_CLIENT_FACTS);
});

test("the SDK's mcp.client.* attributes win over the User-Agent, and the span's own client.address over the HTTP span", () => {
  const spans = [
    httpServer({ "user_agent.original": "node", "client.address": "10.0.0.2" }),
    mcpCall({
      "mcp.client.name": "claude-code",
      "mcp.client.version": "2.0.0",
      "client.address": "203.0.113.1",
      "mcp.protocol.version": "2025-06-18",
    }),
  ];
  assert.deepEqual(
    clientOf(spans, MCP),
    facts({
      harness: "claude-code",
      harnessRaw: "claude-code",
      harnessVersion: "2.0.0",
      harnessSource: "sdk",
      clientIp: "203.0.113.1",
      mcpTransport: "http",
      mcpProtocolVersion: "2025-06-18",
    }),
  );
});

test("an initialize span sets the facts of every MCP span of its session, and its client name wins over the User-Agent", () => {
  const spans = [
    initialize({
      "mcp.session.id": "s1",
      "mcp.client.name": "codex-mcp-client",
      "mcp.client.version": "0.50.0",
      "mcp.protocol.version": "2025-11-25",
      "network.transport": "pipe",
    }),
    span(MCP, {
      name: "tools/call",
      kind: SERVER,
      attributes: {
        "mcp.method.name": "tools/call",
        "mcp.session.id": "s1",
        "user_agent.original": "node",
      },
    }),
  ];
  assert.deepEqual(
    clientOf(spans, MCP),
    facts({
      harness: "codex",
      harnessRaw: "codex-mcp-client",
      harnessVersion: "0.50.0",
      harnessSource: "semconv",
      mcpTransport: "stdio",
      mcpProtocolVersion: "2025-11-25",
    }),
  );
  assert.equal(
    clientOf(spans, INIT).harnessSource,
    "sdk",
    "the initialize span's own attribute is its own fact",
  );
});

test("stored session facts fill a later request's spans; an initialize in the batch wins over them", () => {
  const stored = new Map([
    [
      "s1",
      facts({
        harness: "cursor",
        harnessRaw: "cursor",
        harnessVersion: "1.0",
        harnessSource: "semconv",
        mcpProtocolVersion: "2025-06-18",
        mcpTransport: "http",
      }),
    ],
  ]);
  const later = [mcpCall({ "mcp.session.id": "s1" }, { parentSpanId: null })];
  assert.deepEqual(clientOf(later, MCP, stored), stored.get("s1"));

  const withInit = [
    initialize({ "mcp.session.id": "s1", "mcp.client.name": "opencode" }),
    ...later,
  ];
  assert.equal(clientOf(withInit, MCP, stored).harness, "opencode");
});

test("a stdio span with no client facts stores null and does not fail", () => {
  const spans = [mcpCall({ "network.transport": "pipe" }, { parentSpanId: null })];
  assert.deepEqual(clientOf(spans, MCP), facts({ mcpTransport: "stdio" }));
  assert.deepEqual(clientOf([mcpCall({}, { parentSpanId: null })], MCP), NO_CLIENT_FACTS);
});

test("spans that are no MCP server span get no client facts", () => {
  const spans = [
    httpServer({ "user_agent.original": "claude-code/2.1.3", "client.address": "203.0.113.7" }),
    span(OTHER, { parentSpanId: HTTP }),
  ];
  assert.deepEqual(clientOf(spans, OTHER), NO_CLIENT_FACTS);
  assert.deepEqual(clientOf(spans, HTTP), NO_CLIENT_FACTS);
});

test("sessionsToLookUp lists the sessions of MCP server spans whose initialize is not in the batch", () => {
  const spans = [
    initialize({ "mcp.session.id": "s1" }),
    mcpCall({ "mcp.session.id": "s1" }),
    span(OTHER, {
      kind: SERVER,
      attributes: { "mcp.method.name": "tools/list", "mcp.session.id": "s2" },
    }),
  ];
  assert.deepEqual(sessionsToLookUp(spans), ["s2"]);
});

test("bounded values: an over-long User-Agent product and an invalid IP are dropped or cut", () => {
  const spans = [
    httpServer({ "user_agent.original": `${"x".repeat(500)}/1`, "client.address": "not-an-ip" }),
    mcpCall(),
  ];
  const client = clientOf(spans, MCP);
  assert.equal(client.harnessRaw?.length, 128);
  assert.equal(client.clientIp, null);
});
