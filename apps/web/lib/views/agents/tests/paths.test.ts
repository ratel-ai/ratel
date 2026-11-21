import assert from "node:assert/strict";
import { test } from "node:test";
import { agentHref, agentsHref, agentTracesHref, parseAgentKey } from "../paths";

test("the list and detail links keep the window and the environment", () => {
  assert.equal(agentsHref("p1"), "/project/p1/agents");
  assert.equal(
    agentsHref("p1", { range: "7d", environment: "prod" }),
    "/project/p1/agents?range=7d&facetEnvironment=prod",
  );
  assert.equal(
    agentHref("p1", "research agent/v2", { range: "custom", from: "2026-11-01", to: "2026-11-02" }),
    "/project/p1/agents/research%20agent%2Fv2?range=custom&from=2026-11-01&to=2026-11-02",
  );
});

test("the agent key round-trips through its path segment, and a bad escape stays as it is", () => {
  assert.equal(parseAgentKey(encodeURIComponent("research agent/v2")), "research agent/v2");
  assert.equal(parseAgentKey("100%"), "100%");
});

test("the Traces link filters Turns by the agent with the same window", () => {
  assert.equal(
    agentTracesHref("p1", "researcher", { range: "24h", environment: "staging" }),
    "/project/p1/traces/turns?facetAgent=researcher&range=24h&facetEnvironment=staging",
  );
});

test("a merged agent's Traces link filters by every key merged into it (RC-776)", () => {
  assert.equal(
    agentTracesHref("p1", ["researcher", "research-v1"]),
    "/project/p1/traces/turns?facetAgent=researcher&facetAgent=research-v1",
  );
});
