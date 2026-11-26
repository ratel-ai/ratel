import assert from "node:assert/strict";
import { test } from "node:test";
import { QUERY_VERSION, type SqlQuery } from "@/lib/contracts/query";
import { QueryError } from "@/lib/synthesis/metrics/query";
import { RQL_LIMITS, RQL_VERSION } from "../compile";
import { createRqlGate } from "../domain/gate";
import type { RqlExecution } from "../ports/executor";
import { sqlQueryRunner } from "../query";

/** The RQL gate: places of a project, a queue in order, a wait that ends, and the alert path. */

const P = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-25T12:00:00.000Z");
const SCOPE = { since: new Date(NOW.getTime() - 3_600_000), until: NOW };
const NO_DB = {} as never;
const query: SqlQuery = {
  version: QUERY_VERSION,
  kind: "sql",
  text: "select count(*) from traces",
  rqlVersion: RQL_VERSION,
};

test("a wait for a place gives up after its time, and frees nothing", async () => {
  const gate = createRqlGate(1);
  const leave = gate.enter(P);
  assert.ok(leave);
  const started = Date.now();
  assert.equal(await gate.wait(P, 40), undefined);
  assert.ok(Date.now() - started >= 35);
  leave();
  assert.ok(gate.enter(P), "the place is free again");
});

test("waiting queries get their places in the order they asked", async () => {
  const gate = createRqlGate(1);
  const first = gate.enter(P);
  assert.ok(first);
  const order: number[] = [];
  const waits = [1, 2, 3].map((n) =>
    gate.wait(P, 1000).then((leave) => {
      order.push(n);
      return leave;
    }),
  );
  first();
  for (const wait of waits) (await wait)?.();
  assert.deepEqual(order, [1, 2, 3]);
});

test("enter refuses while queries wait, so a newcomer never jumps the queue", async () => {
  const gate = createRqlGate(1);
  const first = gate.enter(P);
  assert.ok(first);
  const waiting = gate.wait(P, 1000);
  first();
  assert.equal(gate.enter(P), undefined, "the waiting query takes the freed place");
  (await waiting)?.();
});

test("an alert read runs with the alert timeout, and a busy alert path names its own limit", async () => {
  const runs: RqlExecution[] = [];
  const runner = sqlQueryRunner({
    run: {
      executor: { execute: async (run) => (runs.push(run), [[1]]) },
      gate: createRqlGate(),
      observe: async () => {},
    },
    alertGate: createRqlGate(1),
  });
  await runner(P, query, { ...SCOPE, purpose: "alert" }, NO_DB);
  assert.equal(runs[0]?.timeoutMs, RQL_LIMITS.alertTimeoutMs);
  await runner(P, query, SCOPE, NO_DB);
  assert.equal(runs[1]?.timeoutMs, RQL_LIMITS.timeoutMs);

  const full = { enter: () => undefined, wait: async () => undefined };
  const busy = sqlQueryRunner({
    run: { gate: createRqlGate(), observe: async () => {} },
    alertGate: full,
  });
  await assert.rejects(
    busy(P, query, { ...SCOPE, purpose: "alert" }, NO_DB),
    (error: unknown) =>
      error instanceof QueryError &&
      error.detail?.code === "rql_busy" &&
      /1 query at the same time/.test(error.message),
  );
});
