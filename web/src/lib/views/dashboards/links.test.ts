import assert from "node:assert/strict";
import { test } from "node:test";
import { type FunnelStep, funnelQuery } from "@/lib/contracts/query";
import { funnelStepFilter } from "@/lib/views/dashboards/links";

const tool = (name: string): FunnelStep => ({ name, condition: { type: "tool", name } });
const OK: FunnelStep = { name: "ok", condition: { type: "no_error" } };

test("a step opens its traces only when the Traces filter says exactly which", () => {
  const query = funnelQuery([tool("a"), OK, tool("b")], { filters: { services: ["s"] } });
  assert.deepEqual(funnelStepFilter(query, 0), { services: ["s"], tools: ["a"] });
  assert.deepEqual(funnelStepFilter(query, 1), { services: ["s"], tools: ["a"], status: "ok" });
  // Two tools are alternatives in the Traces filter.
  assert.equal(funnelStepFilter(query, 2), null);
  const filtered = funnelQuery([tool("a"), OK], { filters: { tools: ["x"] } });
  assert.equal(funnelStepFilter(filtered, 0), null);
  const skill = funnelQuery([{ name: "s", condition: { type: "skill", name: "s" } }, OK]);
  assert.equal(funnelStepFilter(skill, 0), null);
});
