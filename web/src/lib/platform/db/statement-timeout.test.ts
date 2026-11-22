import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { ConfigError, resolveConfig } from "@/config";
import {
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_SUPPLEMENTARY_READ_TIMEOUT_MS,
  readTimeoutMs,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";

test("withStatementTimeout names and closes the read span", async () => {
  let spanName: string | undefined;
  let spanEnded = false;

  const result = await withStatementTimeout(async () => 42, {
    operation: "trace_kpis",
    db: {} as never,
    timeoutMs: null,
    startActiveSpan: async (name, callback) => {
      spanName = name;
      return callback({
        end() {
          spanEnded = true;
        },
        recordException() {},
        setStatus() {
          return this as never;
        },
      });
    },
  });

  assert.equal(result, 42);
  assert.equal(spanName, "db.read trace_kpis");
  assert.equal(spanEnded, true);
});

test("withStatementTimeout marks the read span as failed and rethrows", async () => {
  let recorded: unknown;
  let status: { code: number; message?: string } | undefined;
  let spanEnded = false;
  const failure = new Error("canceling statement due to statement timeout");

  await assert.rejects(
    withStatementTimeout(
      async () => {
        throw failure;
      },
      {
        operation: "trace_kpis",
        db: {} as never,
        timeoutMs: null,
        startActiveSpan: (_name, callback) =>
          callback({
            end() {
              spanEnded = true;
            },
            recordException(exception) {
              recorded = exception;
            },
            setStatus(next) {
              status = next as { code: number; message?: string };
              return this as never;
            },
          }),
      },
    ),
    failure,
  );

  assert.equal(recorded, failure);
  assert.equal(status?.code, SpanStatusCode.ERROR);
  assert.equal(status?.message, failure.message);
  assert.equal(spanEnded, true);
});

test("readTimeoutMs falls back to the protective default when unset", () => {
  assert.equal(readTimeoutMs(resolveConfig()), DEFAULT_READ_TIMEOUT_MS);
});

test("readTimeoutMs treats an explicit 0 as disabled", () => {
  assert.equal(readTimeoutMs(resolveConfig({ env: { DATABASE_READ_TIMEOUT_MS: "0" } })), null);
});

test("readTimeoutMs honours a valid positive override", () => {
  assert.equal(readTimeoutMs(resolveConfig({ env: { DATABASE_READ_TIMEOUT_MS: "20000" } })), 20000);
});

test("readTimeoutMs: a blank value keeps the default, a malformed one fails the config", () => {
  assert.equal(
    readTimeoutMs(resolveConfig({ env: { DATABASE_READ_TIMEOUT_MS: "" } })),
    DEFAULT_READ_TIMEOUT_MS,
  );
  for (const raw of ["abc", "-5", "1.5"]) {
    assert.throws(
      () => resolveConfig({ env: { DATABASE_READ_TIMEOUT_MS: raw } }),
      ConfigError,
      `expected a ConfigError for ${JSON.stringify(raw)}`,
    );
  }
});

test("supplementaryReadTimeoutMs uses the shorter protective tier by default", () => {
  assert.equal(supplementaryReadTimeoutMs(resolveConfig()), DEFAULT_SUPPLEMENTARY_READ_TIMEOUT_MS);
  assert.equal(DEFAULT_SUPPLEMENTARY_READ_TIMEOUT_MS, 5000);
  assert.ok(DEFAULT_SUPPLEMENTARY_READ_TIMEOUT_MS < DEFAULT_READ_TIMEOUT_MS);
});

test("supplementaryReadTimeoutMs supports explicit disable and override", () => {
  assert.equal(
    supplementaryReadTimeoutMs(
      resolveConfig({ env: { DATABASE_SUPPLEMENTARY_READ_TIMEOUT_MS: "0" } }),
    ),
    null,
  );
  assert.equal(
    supplementaryReadTimeoutMs(
      resolveConfig({ env: { DATABASE_SUPPLEMENTARY_READ_TIMEOUT_MS: "7500" } }),
    ),
    7500,
  );
});

test("supplementaryReadTimeoutMs: a blank value keeps the default, a malformed one fails", () => {
  assert.equal(
    supplementaryReadTimeoutMs(
      resolveConfig({ env: { DATABASE_SUPPLEMENTARY_READ_TIMEOUT_MS: "" } }),
    ),
    DEFAULT_SUPPLEMENTARY_READ_TIMEOUT_MS,
  );
  for (const raw of ["abc", "-5", "1.5"]) {
    assert.throws(
      () => resolveConfig({ env: { DATABASE_SUPPLEMENTARY_READ_TIMEOUT_MS: raw } }),
      ConfigError,
      `expected a ConfigError for ${JSON.stringify(raw)}`,
    );
  }
});
