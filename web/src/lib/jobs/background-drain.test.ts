import assert from "node:assert/strict";
import { test } from "node:test";
import { type BackgroundDrainDeps, startBackgroundDrain } from "./background-drain";
import type { DrainSummary } from "./drain";
import { DEFAULT_DRAIN_TIMEOUT_MS, type DrainLogCode } from "./drain-observer";

/**
 * Upstream's `lib/cron/background-drain.test.ts`, on the core's tick: a drain answers a summary
 * rather than a Response, and the route is closed without a configured secret.
 */

const SECRET = "s3cret";
const summary = (ok = true): DrainSummary => ({
  ok,
  done: 0,
  failed: 0,
  retention: false,
  steps: {},
  duration_ms: 0,
  ...(ok ? {} : { error: "drain failed" }),
});

interface LoggedLine {
  level: "info" | "warn" | "error";
  code: DrainLogCode;
  fields: Record<string, unknown>;
}

function harness(
  secret: string | undefined = SECRET,
  overrides: Partial<BackgroundDrainDeps> = {},
) {
  const scheduled: Array<() => Promise<void>> = [];
  const logged: LoggedLine[] = [];
  const reported: unknown[] = [];
  let drains = 0;
  const pending: Array<() => void> = [];
  const deps: BackgroundDrainDeps = {
    after: (callback) => scheduled.push(callback),
    drain: async () => {
      drains += 1;
      await new Promise<void>((resolve) => pending.push(resolve));
      return summary();
    },
    secret: () => secret,
    timeoutMs: () => DEFAULT_DRAIN_TIMEOUT_MS,
    oldestQueuedJobAgeMs: async () => null,
    log: (level, fields, code) => logged.push({ level, code, fields: { ...fields } }),
    reportException: (error) => reported.push(error),
    ...overrides,
  };
  return {
    deps,
    scheduled,
    logged,
    reported,
    codes: () => logged.map(({ code }) => code),
    line: (code: DrainLogCode) => logged.find((line) => line.code === code),
    drains: () => drains,
    // Settles the oldest drain still in flight.
    finish: () => pending.shift()?.(),
  };
}

const tick = (auth: string | null = `Bearer ${SECRET}`) =>
  new Request("http://localhost/api/cron/drain", auth ? { headers: { authorization: auth } } : {});

test("a tick is answered at once and the drain runs after the response", async () => {
  const h = harness();
  const response = await startBackgroundDrain(tick(), h.deps);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, started: true });
  assert.equal(h.drains(), 0, "nothing ran before the response");
  const run = h.scheduled[0]();
  assert.equal(h.drains(), 1);
  h.finish();
  await run;
});

test("a tick while this task is still draining starts nothing", async () => {
  const h = harness();
  await startBackgroundDrain(tick(), h.deps);
  const run = h.scheduled[0]();
  const busy = await startBackgroundDrain(tick(), h.deps);
  assert.equal(busy.status, 202);
  assert.deepEqual(await busy.json(), { ok: true, skipped: "busy" });
  assert.equal(h.scheduled.length, 1);
  h.finish();
  await run;

  // Once it finished, the next tick drains again.
  const next = await startBackgroundDrain(tick(), h.deps);
  assert.deepEqual(await next.json(), { ok: true, started: true });
  const again = h.scheduled[1]();
  h.finish();
  await again;
});

test("a tick without the cron secret is refused and schedules nothing", async () => {
  const h = harness("s3cret");
  assert.equal((await startBackgroundDrain(tick(null), h.deps)).status, 401);
  assert.equal((await startBackgroundDrain(tick("Bearer nope"), h.deps)).status, 401);
  assert.equal(h.scheduled.length, 0);
  const ok = await startBackgroundDrain(tick("Bearer s3cret"), h.deps);
  assert.equal(ok.status, 202);
  const run = h.scheduled[0]();
  h.finish();
  await run;
});

test("ingest-only and persist-only tasks answer the tick and run nothing, like an API-only one", async () => {
  for (const role of ["ingest", "persist"] as const) {
    const h = harness(SECRET, { role: () => role });
    const response = await startBackgroundDrain(tick(), h.deps);
    assert.equal(response.status, 202, role);
    assert.deepEqual(await response.json(), { ok: true, skipped: "worker" }, role);
    assert.equal(h.drains(), 0, role);
  }
});

test("an API-only task answers the tick and leaves the drain and its heartbeat to the worker", async () => {
  const h = harness(SECRET, { role: () => "api" });
  const response = await startBackgroundDrain(tick(), h.deps);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, skipped: "worker" });
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.drains(), 0);
  assert.deepEqual(h.logged, []);

  // It holds no slot: an all-role tick right after still drains.
  const all = harness(SECRET, { role: () => "all" });
  assert.deepEqual(await (await startBackgroundDrain(tick(), all.deps)).json(), {
    ok: true,
    started: true,
  });
  const run = all.scheduled[0]();
  all.finish();
  await run;
  assert.deepEqual(all.codes(), ["drain_started", "drain_completed"]);
});

test("a drain that throws still frees the slot, and is logged and reported", async () => {
  const thrown = new Error("database gone");
  const h = harness(SECRET, {
    drain: async () => {
      throw thrown;
    },
  });
  await startBackgroundDrain(tick(), h.deps);
  await h.scheduled[0]();
  assert.deepEqual(h.codes(), ["drain_started", "drain_failed"]);
  const failed = h.line("drain_failed");
  assert.equal(failed?.level, "error");
  assert.equal(failed?.fields.err, thrown);
  assert.equal(typeof failed?.fields.duration_ms, "number");
  assert.deepEqual(h.reported, [thrown]);

  const next = await startBackgroundDrain(tick(), h.deps);
  assert.deepEqual(await next.json(), { ok: true, started: true });
  await h.scheduled[1]();
});

test("a drain that reports failure is logged as failed, with its reason", async () => {
  const h = harness(SECRET, { drain: async () => summary(false) });
  await startBackgroundDrain(tick(), h.deps);
  await h.scheduled[0]();
  assert.deepEqual(h.codes(), ["drain_started", "drain_failed"]);
  assert.equal(h.line("drain_failed")?.fields.error, "drain failed");
});

test("without a configured secret the route is closed: a deliberate difference from upstream", async () => {
  const h = harness("");
  assert.equal((await startBackgroundDrain(tick(null), h.deps)).status, 401);
  assert.equal((await startBackgroundDrain(tick("Bearer "), h.deps)).status, 401);
  assert.equal(h.scheduled.length, 0);
});

test("a finished drain logs its duration and the queue lag", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const h = harness(SECRET, { oldestQueuedJobAgeMs: async () => 42_000 });
  await startBackgroundDrain(tick(), h.deps);
  const run = h.scheduled[0]();
  t.mock.timers.tick(30_000);
  h.finish();
  await run;

  assert.deepEqual(h.logged, [
    { level: "info", code: "drain_started", fields: {} },
    {
      level: "info",
      code: "drain_completed",
      fields: { duration_ms: 30_000, ok: true, timed_out: false, oldest_queued_age_ms: 42_000 },
    },
  ]);
});

test("an empty queue reports zero lag, and a long wait logs job_queue_lagging", async () => {
  const empty = harness();
  await startBackgroundDrain(tick(), empty.deps);
  const quiet = empty.scheduled[0]();
  empty.finish();
  await quiet;
  assert.equal(empty.line("drain_completed")?.fields.oldest_queued_age_ms, 0);
  assert.equal(empty.line("job_queue_lagging"), undefined);

  const lagging = harness(SECRET, { oldestQueuedJobAgeMs: async () => 11 * 60 * 1000 });
  await startBackgroundDrain(tick(), lagging.deps);
  const run = lagging.scheduled[0]();
  lagging.finish();
  await run;
  const line = lagging.line("job_queue_lagging");
  assert.equal(line?.level, "warn");
  assert.equal(line?.fields.oldest_queued_age_ms, 11 * 60 * 1000);
});

test("a failed queue-lag read still logs the completed drain", async () => {
  const h = harness(SECRET, {
    oldestQueuedJobAgeMs: async () => {
      throw new Error("read failed");
    },
  });
  await startBackgroundDrain(tick(), h.deps);
  const run = h.scheduled[0]();
  h.finish();
  await run;
  assert.deepEqual(h.codes(), ["drain_started", "drain_queue_lag_read_failed", "drain_completed"]);
  assert.equal("oldest_queued_age_ms" in (h.line("drain_completed")?.fields ?? {}), false);
});

test("a skipped tick logs how long the current drain has run", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const h = harness();
  await startBackgroundDrain(tick(), h.deps);
  const run = h.scheduled[0]();
  t.mock.timers.tick(45_000);
  await startBackgroundDrain(tick(), h.deps);
  assert.deepEqual(h.line("drain_skipped_busy"), {
    level: "info",
    code: "drain_skipped_busy",
    fields: { running_for_ms: 45_000 },
  });
  h.finish();
  await run;
});

test("the watchdog frees a drain that never settles, and its late settle leaves the next drain's slot alone", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const h = harness(SECRET, { timeoutMs: () => 60_000 });
  await startBackgroundDrain(tick(), h.deps);
  const stuck = h.scheduled[0]();

  t.mock.timers.tick(60_000);
  assert.deepEqual(h.line("drain_timed_out"), {
    level: "error",
    code: "drain_timed_out",
    fields: { duration_ms: 60_000, timeout_ms: 60_000 },
  });

  // The slot is free again: the next tick starts a new drain.
  const next = await startBackgroundDrain(tick(), h.deps);
  assert.deepEqual(await next.json(), { ok: true, started: true });
  const fresh = h.scheduled[1]();

  // The stuck drain settles late; it must not free the fresh drain's slot.
  h.finish();
  await stuck;
  assert.equal(
    h.logged.filter(({ code }) => code === "drain_completed").at(0)?.fields.timed_out,
    true,
  );
  const busy = await startBackgroundDrain(tick(), h.deps);
  assert.deepEqual(await busy.json(), { ok: true, skipped: "busy" });

  h.finish();
  await fresh;
});

test("the watchdog of an API tick restarts on job progress, and still frees a drain that stops making progress", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  let onProgress: () => void = () => {};
  const h = harness(SECRET, {
    timeoutMs: () => 60_000,
    drain: (progress) => {
      onProgress = progress ?? (() => {});
      return new Promise<DrainSummary>(() => {});
    },
  });
  await startBackgroundDrain(tick(), h.deps);
  void h.scheduled[0]();

  for (let job = 0; job < 3; job++) {
    t.mock.timers.tick(50_000);
    onProgress();
  }
  assert.equal(h.codes().includes("drain_timed_out"), false);
  assert.equal(h.codes().filter((c) => c === "drain_progress").length, 3);

  t.mock.timers.tick(60_000);
  assert.deepEqual(h.line("drain_timed_out")?.fields, { duration_ms: 210_000, timeout_ms: 60_000 });
  const logged = h.logged.length;
  onProgress();
  assert.equal(h.logged.length, logged);
});

test("a zero timeout turns the watchdog off", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const h = harness(SECRET, { timeoutMs: () => 0 });
  await startBackgroundDrain(tick(), h.deps);
  const run = h.scheduled[0]();
  t.mock.timers.tick(DEFAULT_DRAIN_TIMEOUT_MS * 10);
  assert.equal(h.line("drain_timed_out"), undefined);
  h.finish();
  await run;
});
