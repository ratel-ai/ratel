import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { detectionOf, explainDetection, weakestSource } from "./detection";

test("detectionOf reads a heuristic source with the entity's rule", () => {
  assert.deepEqual(detectionOf("agent", "heuristic", { fromService: true }), {
    source: "heuristic",
    rule: "service-name",
  });
  assert.deepEqual(detectionOf("agent", "heuristic", { fromService: false }), {
    source: "heuristic",
    rule: "agent-span-name",
  });
  assert.deepEqual(detectionOf("mcp-server", "heuristic"), {
    source: "heuristic",
    rule: "tool-prefix",
  });
  assert.deepEqual(detectionOf("client", "heuristic"), { source: "heuristic", rule: "user-agent" });
});

test("detectionOf gives an explicit source no rule", () => {
  assert.deepEqual(detectionOf("agent", "sdk"), { source: "sdk", rule: null });
  assert.deepEqual(detectionOf("client", "semconv"), { source: "semconv", rule: null });
});

test("detectionOf is null for a missing or unknown source", () => {
  assert.equal(detectionOf("agent", null), null);
  assert.equal(detectionOf("agent", "guess"), null);
});

test("explainDetection names the rule and the attribute that makes a guess explicit", () => {
  assert.deepEqual(explainDetection({ source: "heuristic", rule: "service-name" }), {
    label: "Guessed",
    tone: "warning",
    rule: "from service.name",
    fix: "Set gen_ai.agent.name on the agent's spans to name it explicitly.",
  });
  assert.equal(
    explainDetection({ source: "heuristic", rule: "agent-span-name" }).rule,
    "from the agent span name",
  );
  const prefix = explainDetection({ source: "heuristic", rule: "tool-prefix" });
  assert.equal(prefix.rule, "from the tool name prefix");
  assert.match(prefix.fix ?? "", /ratel\.upstream\.server/);
  const agent = explainDetection({ source: "heuristic", rule: "user-agent" });
  assert.equal(agent.rule, "from the User-Agent header");
  assert.match(agent.fix ?? "", /mcp\.client\.name/);
});

test("explainDetection shows explicit sources with no warning", () => {
  assert.deepEqual(explainDetection({ source: "sdk", rule: null }), {
    label: "Ratel SDK",
    tone: "neutral",
    rule: "from the Ratel SDK",
    fix: null,
  });
  assert.deepEqual(explainDetection({ source: "semconv", rule: null }), {
    label: "OpenTelemetry",
    tone: "neutral",
    rule: "from an OpenTelemetry attribute",
    fix: null,
  });
});

test("weakestSource aggregates to the weakest source of the group", () => {
  const query = new PgDialect().sqlToQuery(sql`select ${weakestSource(sql`s.agent_source`)}`);
  assert.match(
    query.sql,
    /min\(case s\.agent_source when 'heuristic' then 0 when 'semconv' then 1 when 'sdk' then 2 end\)/,
  );
  assert.match(query.sql, /when 0 then 'heuristic' when 1 then 'semconv' when 2 then 'sdk'/);
});
