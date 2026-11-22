import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ingest } from "@/lib/ingest/otlp/dimensions/client-facts-support";
import { PROJECT_ID } from "@/lib/readings/trace-signals/signals/integration-support";

/**
 * Pins the agent the agent_failing signal reads today (`trace_events.payload
 * ->> 'agent'`) for a tool call under an `invoke_agent` span with no agent
 * attribute (RC-1014, decision agent-failing-stays-payload). The payload names
 * the whole span name, while `otel_spans.agent_key` strips the operation. A
 * later move of the signal to the column must keep these subjects.
 */

const FIXTURE = join(
  process.cwd(),
  "lib/ingest/otlp/__fixtures__/entity-dimensions/agent.otlp.json",
);

test("a tool call under an invoke_agent span with no agent attribute: payload.agent is the span name, agent_key is the agent", async () => {
  const body = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    resourceSpans: { scopeSpans: { spans: { attributes?: { key: string }[] }[] }[] }[];
  };
  for (const resource of body.resourceSpans) {
    for (const scope of resource.scopeSpans) {
      for (const span of scope.spans)
        span.attributes = span.attributes?.filter(
          (attribute) => attribute.key !== "gen_ai.agent.name",
        );
    }
  }
  const { client } = await ingest([JSON.stringify(body)]);
  try {
    const { rows } = await client.query<{ agent: string | null; agent_key: string | null }>(
      `select e.payload ->> 'agent' as agent, s.agent_key
       from trace_events e
       join otel_spans s on s.project_id = e.project_id and s.trace_id = e.trace_id and s.span_id = e.span_id
       where e.project_id = $1 and e.ingest_source = 'otlp' and e.type in ('invoke_end', 'invoke_error')`,
      [PROJECT_ID],
    );
    assert.deepEqual(rows, [{ agent: "invoke_agent researcher", agent_key: "researcher" }]);
  } finally {
    await client.close();
  }
});
