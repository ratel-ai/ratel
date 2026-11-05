import assert from "node:assert/strict";
import { test } from "node:test";
import { type LineageRouteDeps, lineageResponse } from "./route";
import type { LineageRef } from "./types";

const TRACE: LineageRef = {
  stage: "monitor",
  kind: "trace",
  id: "t1",
  href: "/project/p1/traces/t1",
};

function deps(
  over: Partial<LineageRouteDeps> = {},
): LineageRouteDeps & { calls: unknown[]; errors: string[] } {
  const calls: unknown[] = [];
  const errors: string[] = [];
  return {
    calls,
    errors,
    enabled: async () => true,
    dbConfigured: () => true,
    getSession: async () => ({ userId: "u1" }),
    findProject: async (id) =>
      id === "p1" ? { projectId: "p1", organizationId: "o1", traces: true } : null,
    resolve: async (ref, ctx, chain) => {
      calls.push({ ref, ctx, chain });
      return chain ? [TRACE, { ...ref, href: "/x" }] : TRACE;
    },
    setLogContext: () => {},
    logError: (_fields, message) => errors.push(message),
    reportException: () => {},
    ...over,
  };
}

const Q = { kind: "insight", id: "s1", chain: false };

test("an insight answers with the source one step back, read with the plan's say on runs", async () => {
  const d = deps({
    findProject: async () => ({ projectId: "p1", organizationId: "o1", traces: false }),
  });
  const response = await lineageResponse("p1", Q, d);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    ref: { stage: "insights", kind: "insight", id: "s1" },
    source: TRACE,
  });
  assert.deepEqual(d.calls, [
    {
      ref: { stage: "insights", kind: "insight", id: "s1" },
      ctx: { projectId: "p1", traces: false },
      chain: false,
    },
  ]);
});

test("chain=1 answers with the whole way back", async () => {
  const body = (await (await lineageResponse("p1", { ...Q, chain: true }, deps())).json()) as {
    chain: LineageRef[];
  };
  assert.deepEqual(
    body.chain.map((ref) => ref.kind),
    ["trace", "insight"],
  );
});

test("off, signed out, someone else's project, or a bad ref: no answer", async () => {
  assert.equal(
    (await lineageResponse("p1", Q, deps({ enabled: async () => false }))).status,
    404,
    "the flag hides it",
  );
  assert.equal(
    (await lineageResponse("p1", Q, deps({ getSession: async () => null }))).status,
    401,
  );
  assert.equal((await lineageResponse("p2", Q, deps())).status, 404);
  assert.equal(
    (await lineageResponse("p1", { ...Q, kind: "release" }, deps())).status,
    400,
    "a kind the spine does not know",
  );
  assert.equal((await lineageResponse("p1", { ...Q, id: null }, deps())).status, 400);
  assert.equal((await lineageResponse("p1", { ...Q, id: "x".repeat(600) }, deps())).status, 400);
});

test("a failed read is logged and reported, and says so kindly", async () => {
  const d = deps({ resolve: async () => Promise.reject(new Error("timeout")) });
  const response = await lineageResponse("p1", Q, d);
  assert.equal(response.status, 503);
  assert.deepEqual(d.errors, ["lineage read failed"]);
  assert.match(((await response.json()) as { message: string }).message, /Try again/);
});
