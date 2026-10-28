import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import {
  attachPoolErrorHandler,
  isDbConfigured,
  type PoolErrorObservabilityDeps,
  sslConfig,
} from "./client";

test("idle pool errors log before guarded exception capture", () => {
  let errorHandler: ((error: Error) => void) | undefined;
  const pool = {
    on(event: string, handler: (error: Error) => void) {
      assert.equal(event, "error");
      errorHandler = handler;
      return this;
    },
  } as unknown as Pick<Pool, "on">;
  const order: string[] = [];
  const captures: unknown[][] = [];
  const deps: PoolErrorObservabilityDeps = {
    logError: () => order.push("log"),
    reportServerException: (...args) => {
      order.push("capture");
      captures.push(args);
    },
  };

  attachPoolErrorHandler(pool, deps);
  const failure = new Error("idle client disconnected");
  errorHandler?.(failure);

  assert.deepEqual(order, ["log", "capture"]);
  assert.deepEqual(captures, [[failure, "system:database", { component: "pg_pool" }]]);
});

test("TLS is off for a local database and on elsewhere unless DATABASE_SSL says otherwise", () => {
  assert.equal(sslConfig("postgres://ratel@localhost:5432/ratel", undefined), false);
  assert.deepEqual(sslConfig("postgres://ratel@db.internal:5432/ratel", undefined), {
    rejectUnauthorized: false,
  });
  assert.equal(sslConfig("postgres://ratel@db.internal:5432/ratel", "disable"), false);
});

test("isDbConfigured reads DATABASE_URL", () => {
  const previous = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = "";
    assert.equal(isDbConfigured(), false);
    process.env.DATABASE_URL = "postgres://x";
    assert.equal(isDbConfigured(), true);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
