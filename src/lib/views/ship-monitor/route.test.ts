import assert from "node:assert/strict";
import { test } from "node:test";
import { type WatchRouteDeps, watchResponse } from "./route";
import type { ShipmentWatch } from "./watch";

const WATCH = { shipment: { id: "s1" } } as unknown as ShipmentWatch;

function deps(over: Partial<WatchRouteDeps> = {}) {
  const seen: { shipmentId?: string }[] = [];
  const out: WatchRouteDeps = {
    dbConfigured: () => true,
    getSession: async () => ({ userId: "u1" }),
    findProject: async (projectId) => ({ projectId, organizationId: "o1", enabled: true }),
    loadWatches: async (_projectId, options) => {
      seen.push({ shipmentId: options.shipmentId });
      return [WATCH];
    },
    now: () => new Date("2026-11-17T12:00:00Z"),
    setLogContext: () => undefined,
    logError: () => undefined,
    reportException: () => undefined,
    ...over,
  };
  return { deps: out, seen };
}

test("a member with the watch on gets the watches, never cached", async () => {
  const { deps: d, seen } = deps();
  const response = await watchResponse("p1", { shipmentId: "s1" }, d);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, watches: [WATCH] });
  assert.deepEqual(seen, [{ shipmentId: "s1" }]);
});

test("no session is 401; another project or the watch turned off is 404", async () => {
  assert.equal(
    (await watchResponse("p1", {}, deps({ getSession: async () => null }).deps)).status,
    401,
  );
  assert.equal(
    (await watchResponse("p1", {}, deps({ findProject: async () => null }).deps)).status,
    404,
  );
  assert.equal(
    (
      await watchResponse(
        "p1",
        {},
        deps({
          findProject: async (projectId) => ({ projectId, organizationId: "o1", enabled: false }),
        }).deps,
      )
    ).status,
    404,
  );
});

test("a failed read is logged, reported and answered with 503", async () => {
  const logged: string[] = [];
  const { deps: d } = deps({
    loadWatches: async () => {
      throw new Error("timeout");
    },
    logError: (_fields, message) => logged.push(message),
  });
  const response = await watchResponse("p1", {}, d);
  assert.equal(response.status, 503);
  assert.deepEqual(logged, ["ship watch read failed"]);
});
