import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ingest, otlp, type SpanSpec } from "@/lib/ingest/otlp/dimensions/client-facts-support";
import { mmdbGeoLookup } from "@/lib/ingest/otlp/dimensions/geo";
import { PROJECT_ID } from "@/lib/readings/trace-signals/signals/integration-support";
import { getTraceSpansWithTruncation } from "./queries";

/**
 * The span detail's Client block (RC-778): the spans the trace page loads
 * carry the client facts. The caller's IP is never there: ingest reads its
 * country and drops it (RP-138), for every reader.
 */

const IP = "81.2.69.160";
const TRACE = "c".repeat(32);
const [HTTP, CALL] = ["1".repeat(16), "2".repeat(16)];
const GEO = mmdbGeoLookup(
  readFileSync(join(process.cwd(), "lib/ingest/otlp/__fixtures__/geo/GeoIP2-Country-Test.mmdb")),
);

const SPANS: SpanSpec[] = [
  {
    traceId: TRACE,
    spanId: HTTP,
    name: "POST /mcp",
    kind: 2,
    startMs: 0,
    endMs: 50,
    attributes: {
      "http.request.method": "POST",
      "user_agent.original": "claude-code/2.1.3",
      "client.address": IP,
    },
  },
  {
    traceId: TRACE,
    spanId: CALL,
    parentSpanId: HTTP,
    name: "tools/call get_forecast",
    kind: 2,
    startMs: 5,
    endMs: 40,
    attributes: {
      "mcp.method.name": "tools/call",
      "gen_ai.tool.name": "get_forecast",
      "network.transport": "tcp",
    },
  },
];

test("the client facts are there, the caller's IP is not", async () => {
  const { client, db } = await ingest([otlp(SPANS)], { geo: GEO });
  try {
    const spans = (await getTraceSpansWithTruncation(PROJECT_ID, TRACE, db)).spans;
    const call = spans.find((span) => span.spanId === CALL);
    assert.equal(call?.harness, "claude-code");
    assert.equal(call?.geoCountry, "GB");
    assert.equal(call?.mcpTransport, "http");
    assert.equal(JSON.stringify(spans).includes(IP), false, "no span holds the caller's IP");
  } finally {
    await client.close();
  }
});
