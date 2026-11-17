import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecodedSpan, IExportTraceServiceRequest } from "@/lib/ingest/otlp/types";
import { REDACTED } from "./redact";
import { type TraceRawRouteDeps, traceRawResponse } from "./trace-raw-route";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN: DecodedSpan = {
  traceId: TRACE_ID,
  spanId: "00f067aa0ba902b7",
  parentSpanId: null,
  name: "execute_tool search",
  kind: 1,
  startUnixMs: 1_000,
  endUnixMs: 2_000,
  attributes: {
    "gen_ai.tool.call.arguments": '{"q":"rome"}',
    "http.request.header.authorization": "Bearer fake-1",
    "url.full": "https://api.example.com/search?q=rome&api_key=fake-2",
  },
  events: [
    {
      name: "gen_ai.choice",
      timeUnixMs: 1_500,
      attributes: { "gen_ai.output.messages": "[]", index: 0 },
    },
  ],
  statusCode: 0,
  resourceAttributes: { "service.name": "agent" },
  scopeName: "scope",
};
const EXPORT: IExportTraceServiceRequest = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "agent" } }] },
      scopeSpans: [
        {
          scope: { name: "scope" },
          spans: [
            {
              traceId: TRACE_ID,
              spanId: SPAN.spanId,
              name: SPAN.name,
              attributes: [
                { key: "gen_ai.tool.call.arguments", value: { stringValue: '{"q":"rome"}' } },
                {
                  key: "http.request.header.authorization",
                  value: { stringValue: "Bearer fake-1" },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

test("a member with the flag on gets each span's full attributes, resource and events, credentials redacted", async () => {
  const response = await traceRawResponse(
    request(),
    { projectId: PROJECT_ID, traceId: TRACE_ID.toUpperCase() },
    deps(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    exports: 1,
    truncated: false,
    contentWithheld: false,
    spans: [
      {
        spanId: SPAN.spanId,
        attributes: {
          "gen_ai.tool.call.arguments": '{"q":"rome"}',
          "http.request.header.authorization": REDACTED,
          "url.full": `https://api.example.com/search?q=rome&api_key=${REDACTED}`,
        },
        resourceAttributes: SPAN.resourceAttributes,
        events: SPAN.events,
        scopeName: "scope",
      },
    ],
  });
});

test("with read_content off, the raw view and the download leave content out", async () => {
  const params = { projectId: PROJECT_ID, traceId: TRACE_ID };
  const off = deps({ readContent: async () => false });

  const view = (await (await traceRawResponse(request(), params, off)).json()) as {
    contentWithheld: boolean;
    spans: Array<{
      attributes: Record<string, unknown>;
      events: Array<{ attributes: Record<string, unknown> }>;
    }>;
  };
  const download = await (await traceRawResponse(request("?format=otlp"), params, off)).text();

  assert.equal(view.contentWithheld, true);
  assert.deepEqual(Object.keys(view.spans[0].attributes), [
    "http.request.header.authorization",
    "url.full",
  ]);
  assert.deepEqual(view.spans[0].events[0].attributes, {});
  assert.equal(download.includes("rome"), false);
});

test("format=otlp downloads the trace as an OTLP JSON file", async () => {
  const response = await traceRawResponse(
    request("?format=otlp"),
    { projectId: PROJECT_ID, traceId: TRACE_ID },
    deps(),
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /attachment; filename="trace-0af76519.*\.otlp\.json"/,
  );
  assert.equal(response.headers.get("x-ratel-otlp-truncated"), null);
  const body = await response.text();
  assert.equal(JSON.parse(body).resourceSpans.length, 1);
  assert.equal(body.includes("fake-1"), false, "credentials are redacted");
  assert.equal(body.includes(REDACTED), true);
});

test("a download that skipped an undecodable export is marked partial", async () => {
  const response = await traceRawResponse(
    request("?format=otlp"),
    { projectId: PROJECT_ID, traceId: TRACE_ID },
    deps({
      loadRawOtlp: async () => ({
        requests: [EXPORT],
        exports: 2,
        undecodable: 1,
        truncated: false,
      }),
    }),
  );

  assert.equal(response.headers.get("x-ratel-otlp-truncated"), "true");
});

test("a download cut at the read bounds is marked partial", async () => {
  const response = await traceRawResponse(
    request("?format=otlp"),
    { projectId: PROJECT_ID, traceId: TRACE_ID },
    deps({
      loadRawOtlp: async () => ({
        requests: [EXPORT],
        exports: 50,
        undecodable: 0,
        truncated: true,
      }),
    }),
  );

  assert.equal(response.headers.get("x-ratel-otlp-truncated"), "true");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /filename="trace-0af76519\w+\.partial\.otlp\.json"/,
  );
});

test("no session is 401, an unknown project and a flag off are 404", async () => {
  const params = { projectId: PROJECT_ID, traceId: TRACE_ID };
  assert.equal(
    (await traceRawResponse(request(), params, deps({ getSession: async () => null }))).status,
    401,
  );
  assert.equal(
    (await traceRawResponse(request(), params, deps({ findProject: async () => null }))).status,
    404,
  );
  assert.equal(
    (await traceRawResponse(request(), params, deps({ flagEnabled: async () => false }))).status,
    404,
  );
});

test("a trace id that is not hex is 404 and reads nothing", async () => {
  let reads = 0;
  const response = await traceRawResponse(
    request(),
    { projectId: PROJECT_ID, traceId: "not-a-trace" },
    deps({
      loadRaw: async () => (
        (reads += 1), { spans: [], exports: 0, undecodable: 0, truncated: false }
      ),
    }),
  );

  assert.equal(response.status, 404);
  assert.equal(reads, 0);
});

test("with content switched off for the project, the route returns no raw spans and no download", async () => {
  let reads = 0;
  const off = deps({
    contentEnabled: async () => false,
    loadRaw: async () => (
      (reads += 1), { spans: [SPAN], exports: 1, undecodable: 0, truncated: false }
    ),
  });
  const params = { projectId: PROJECT_ID, traceId: TRACE_ID };

  const spans = await traceRawResponse(request(), params, off);
  const download = await traceRawResponse(request("?format=otlp"), params, off);

  assert.deepEqual(await spans.json(), {
    ok: true,
    exports: 0,
    truncated: false,
    contentWithheld: true,
    spans: [],
  });
  assert.equal(download.status, 404);
  assert.equal(reads, 0);
});

function request(search = ""): Request {
  return new Request(`http://localhost/api/projects/${PROJECT_ID}/traces/${TRACE_ID}/raw${search}`);
}

function deps(overrides: Partial<TraceRawRouteDeps> = {}): TraceRawRouteDeps {
  return {
    getSession: async () => ({ userId: "u1", externalId: "user_1" }),
    findProject: async (projectId) => ({ projectId }),
    flagEnabled: async () => true,
    contentEnabled: async () => true,
    readContent: async () => true,
    loadRawOtlp: async () => ({ requests: [EXPORT], exports: 1, undecodable: 0, truncated: false }),
    loadRaw: async () => ({ spans: [SPAN], exports: 1, undecodable: 0, truncated: false }),
    setLogContext: () => {},
    ...overrides,
  };
}
