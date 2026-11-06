import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyRouteHref } from "./legacy-route";

const PROJECT = "a7654cd9-a761-4bb1-8606-cb107e4c8d22";
const scope = { projects: [{ id: PROJECT, slug: "acme" }], organizationSlug: "acme-org" };

test("a top-level address lands in the named project, the query kept", async () => {
  assert.equal(
    await legacyRouteHref("/traces", { project: "acme", range: "7d" }, scope),
    `/project/${PROJECT}/traces?range=7d`,
  );
  assert.equal(
    await legacyRouteHref("/traces/events", { project: "acme" }, scope),
    `/project/${PROJECT}/traces/logs`,
  );
  assert.equal(
    await legacyRouteHref("/experiments/exp-1", { project: "acme" }, scope),
    `/project/${PROJECT}/calibration/exp-1`,
  );
  assert.equal(
    await legacyRouteHref("/settings", { project: "acme" }, scope),
    `/project/${PROJECT}/settings`,
  );
});

test("an unknown or missing project slug leaves the sentinel to pick the project", async () => {
  assert.equal(await legacyRouteHref("/traces", {}, scope), "/project/_/traces");
  assert.equal(await legacyRouteHref("/traces", { project: "other" }, scope), "/project/_/traces");
  assert.equal(await legacyRouteHref("/traces", {}, null), "/project/_/traces");
});

test("explore lands on the skills catalog, its retired tabs on Fixes with their parameters dropped", async () => {
  assert.equal(
    await legacyRouteHref("/explore", { project: "acme" }, scope),
    `/project/${PROJECT}/catalogs/skills`,
  );
  assert.equal(
    await legacyRouteHref("/explore", { project: "acme", tab: "intents", intentsPage: "2" }, scope),
    `/project/${PROJECT}/improvement/fixes`,
  );
});

test("an address no rule knows is nobody's", async () => {
  assert.equal(await legacyRouteHref("/somewhere", {}, scope), null);
});
