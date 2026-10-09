import assert from "node:assert/strict";
import test from "node:test";
import { runSearch } from "./search.js";

test("anonymous HTTP discovery and ranked catalog invocation preserve request identity", async () => {
  const requests: { method: string; params?: Record<string, unknown> }[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://search.parallel.ai/mcp");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("user-agent"), "ratel-parallel-search-example/0.0.0");
    assert.equal(headers.get("authorization"), null);
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    if (request.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === "initialize") {
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    } else if (request.method === "tools/list") {
      result = {
        tools: [
          {
            name: "web_search",
            description: "Search the web for information",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "web_fetch",
            description: "Fetch a web page URL",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    } else {
      assert.equal(request.method, "tools/call");
      result = {
        content: [
          {
            type: "text",
            text:
              request.params.name === "web_search"
                ? "Search result: https://example.com"
                : "Example page content",
          },
        ],
      };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      headers: { "content-type": "application/json" },
    });
  };
  const result = await runSearch({
    query: "web search information",
    url: "https://example.com",
    fetch: mockFetch,
  });
  assert.match(JSON.stringify(result.search), /Search result/);
  assert.match(JSON.stringify(result.page), /Example page content/);
  assert.ok(result.rankedToolIds.includes("parallel__web_search"));
  const calls = requests.filter((r) => r.method === "tools/call");
  assert.equal(calls.length, 2);
  const search = calls[0].params as { name: string; arguments: Record<string, unknown> };
  const page = calls[1].params as { name: string; arguments: Record<string, unknown> };
  assert.equal(search.name, "web_search");
  assert.deepEqual(search.arguments.search_queries, ["web search information"]);
  assert.equal(page.name, "web_fetch");
  assert.deepEqual(page.arguments.urls, ["https://example.com"]);
  assert.equal(search.arguments.session_id, page.arguments.session_id);
  assert.match(String(search.arguments.session_id), /^[a-f0-9-]{36}$/);
});
