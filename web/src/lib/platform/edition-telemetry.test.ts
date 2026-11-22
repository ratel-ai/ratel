import assert from "node:assert/strict";
import { test } from "node:test";
import { onRequestError } from "@/instrumentation";
import type { TelemetryPort } from "@/lib/contracts/telemetry";
import { editionAnalyticsShutdown, forwardRequestError } from "./edition-telemetry";

const base: TelemetryPort = {
  trackEvent: async () => {},
  reportException: () => {},
};

const request = { path: "/api/x?token=t", method: "POST", headers: { cookie: "a=b" } };
const context = {
  routerKind: "App Router",
  routePath: "/api/x",
  routeType: "route",
  revalidateReason: undefined,
} as const;

test("an uncaught request error goes to the edition's port with the request and its route", async () => {
  const seen: unknown[][] = [];
  const error = new Error("aborted");
  await forwardRequestError(error, request, context, async () => ({
    ...base,
    reportRequestError: async (...args) => {
      seen.push(args);
    },
  }));
  assert.deepEqual(seen, [[error, request, context]]);
});

test("without the port, or when it throws, a request error is dropped quietly", async () => {
  await forwardRequestError(new Error("x"), request, context, async () => base);
  const warnings: unknown[] = [];
  await forwardRequestError(
    new Error("x"),
    request,
    context,
    async () => ({
      ...base,
      reportRequestError: async () => {
        throw new Error("analytics down");
      },
    }),
    (error) => {
      warnings.push(error);
    },
  );
  assert.equal(warnings.length, 1);
  await forwardRequestError(
    new Error("x"),
    request,
    context,
    async () => {
      throw new Error("composition failed");
    },
    () => {},
  );
});

test("the analytics shutdown loads the port only when it runs, and passes the timeout", async () => {
  let loads = 0;
  const timeouts: number[] = [];
  const shutdown = editionAnalyticsShutdown(5_000, async () => {
    loads += 1;
    return { ...base, shutdown: async (timeoutMs) => void timeouts.push(timeoutMs) };
  });
  assert.equal(loads, 0);
  await shutdown();
  assert.equal(loads, 1);
  assert.deepEqual(timeouts, [5_000]);
});

test("an edition without a shutdown flushes nothing", async () => {
  await editionAnalyticsShutdown(5_000, async () => base)();
});

test("onRequestError does nothing outside the Node runtime", async () => {
  const runtime = process.env.NEXT_RUNTIME;
  process.env.NEXT_RUNTIME = "edge";
  try {
    await onRequestError(new Error("x"), request, context);
  } finally {
    if (runtime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = runtime;
  }
});
