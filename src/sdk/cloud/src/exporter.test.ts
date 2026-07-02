import { ToolCatalog, TraceSession } from "@ratel-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAuthError, CloudClient } from "./index.js";
import { type MockCloud, startMockCloud } from "./testing/mock-cloud.js";

let mock: MockCloud;

afterEach(async () => {
  await mock?.close();
});

function setup(exporterOpts: Parameters<CloudClient["createExporter"]>[1] = {}) {
  const client = new CloudClient({ baseUrl: mock.url, apiKey: mock.apiKey });
  const session = new TraceSession({ sessionId: "sess-1", harness: "vitest" });
  const catalog = new ToolCatalog({ traceSession: session });
  const exporter = client.createExporter(session, exporterOpts);
  return { client, session, catalog, exporter };
}

function emit(catalog: ToolCatalog, n: number): void {
  for (let i = 0; i < n; i++) {
    catalog.recordEvent({ type: "auth_needs", upstream: `u${i}` });
  }
}

function traceBodies(): unknown[] {
  return mock.requests
    .filter((r) => r.path === "/api/v1/trace-events")
    .flatMap((r) => (Array.isArray(r.body) ? r.body : [r.body]));
}

describe("CloudExporter.flush", () => {
  it("posts drained envelopes with bearer auth, client_event_id and occurred_at", async () => {
    mock = await startMockCloud();
    const { catalog, exporter } = setup();
    emit(catalog, 2);

    await exporter.flush();

    const request = mock.requests.find((r) => r.path === "/api/v1/trace-events");
    expect(request?.headers.authorization).toBe(`Bearer ${mock.apiKey}`);
    const events = traceBodies() as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events[0].client_event_id).toBe("sess-1:0");
    expect(events[1].client_event_id).toBe("sess-1:1");
    expect(typeof events[0].occurred_at).toBe("string");
    expect(new Date(events[0].occurred_at as string).getTime()).toBe(events[0].ts);
    expect(events[0].harness).toBe("vitest");
  });

  it("splits past maxBatchSize into multiple requests", async () => {
    mock = await startMockCloud();
    const { catalog, exporter } = setup({ maxBatchSize: 2 });
    emit(catalog, 5);

    await exporter.flush();

    const posts = mock.requests.filter((r) => r.path === "/api/v1/trace-events");
    expect(posts.map((r) => (r.body as unknown[]).length)).toEqual([2, 2, 1]);
  });

  it("retries a failed batch idempotently (same client_event_ids, no duplicates)", async () => {
    mock = await startMockCloud();
    let failures = 1;
    mock.traceEventsResponder = () => {
      if (failures > 0) {
        failures -= 1;
        return { status: 500, payload: { error: "boom" } };
      }
      return { status: 202, payload: { accepted: 2, rejected: [] } };
    };
    const { catalog, exporter } = setup({ retryBackoffMs: 5 });
    emit(catalog, 2);

    await exporter.flush(); // fails, re-buffered
    await new Promise((resolve) => setTimeout(resolve, 10)); // past backoff
    await exporter.flush(); // retries

    const posts = mock.requests.filter((r) => r.path === "/api/v1/trace-events");
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toEqual(posts[1].body);
  });

  it("does not retry 202-rejected items; surfaces them via onRejected", async () => {
    mock = await startMockCloud();
    mock.traceEventsResponder = () => ({
      status: 202,
      payload: { accepted: 1, rejected: [{ index: 1, error: "invalid" }] },
    });
    const rejected: unknown[] = [];
    const { catalog, exporter } = setup({ onRejected: (items) => rejected.push(...items) });
    emit(catalog, 2);

    await exporter.flush();
    mock.traceEventsResponder = undefined;
    await exporter.flush();

    expect(rejected).toEqual([{ index: 1, error: "invalid" }]);
    const posts = mock.requests.filter((r) => r.path === "/api/v1/trace-events");
    expect(posts).toHaveLength(1); // nothing left to resend
  });

  it("drops oldest past maxBufferedEvents while Cloud is down", async () => {
    mock = await startMockCloud();
    mock.traceEventsResponder = () => ({ status: 500, payload: {} });
    const { catalog, exporter } = setup({ maxBufferedEvents: 3, retryBackoffMs: 0 });
    emit(catalog, 5);

    await exporter.flush(); // fails; buffer capped at 3 newest
    mock.traceEventsResponder = undefined;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await exporter.flush();

    const delivered = traceBodies() as Array<Record<string, unknown>>;
    const successBatch = delivered.slice(-3);
    expect(successBatch.map((e) => e.upstream)).toEqual(["u2", "u3", "u4"]);
    expect(exporter.droppedCount()).toBe(2);
  });

  it("halves the batch on 413 and still delivers everything", async () => {
    mock = await startMockCloud();
    let calls = 0;
    mock.traceEventsResponder = (body) => {
      calls += 1;
      const events = Array.isArray(body) ? body : [body];
      if (events.length > 2) return { status: 413, payload: { error: "too large" } };
      return { status: 202, payload: { accepted: events.length, rejected: [] } };
    };
    const { catalog, exporter } = setup({ maxBatchSize: 4, retryBackoffMs: 0 });
    emit(catalog, 4);

    await exporter.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await exporter.flush();

    const delivered = traceBodies() as Array<Record<string, unknown>>;
    const ids = delivered.map((e) => e.client_event_id);
    expect(new Set(ids.slice(-4)).size).toBe(4);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("stops the timer on auth rejection", async () => {
    mock = await startMockCloud();
    const errors: Error[] = [];
    const { catalog, exporter } = setup({
      flushIntervalMs: 5,
      onError: (err) => errors.push(err),
    });
    const badClient = exporter; // exporter uses the good key; force 401 via responder
    mock.traceEventsResponder = () => ({ status: 401, payload: { error: "unauthorized" } });
    emit(catalog, 1);

    badClient.start();
    await vi.waitFor(() => {
      expect(errors.length).toBeGreaterThan(0);
    });
    expect(errors[0]).toBeInstanceOf(CloudAuthError);
    expect(badClient.isRunning()).toBe(false);
    await badClient.shutdown();
  });

  it("start() flushes on the interval; shutdown() performs a final flush", async () => {
    mock = await startMockCloud();
    const { catalog, exporter } = setup({ flushIntervalMs: 5 });
    emit(catalog, 1);

    exporter.start();
    await vi.waitFor(() => {
      expect(traceBodies().length).toBe(1);
    });

    emit(catalog, 1);
    await exporter.shutdown();
    expect(traceBodies().length).toBe(2);
    expect(exporter.isRunning()).toBe(false);
  });
});

describe("CloudClient.reportRunMetrics", () => {
  it("posts the per-run record and resolves on 202", async () => {
    mock = await startMockCloud();
    const client = new CloudClient({ baseUrl: mock.url, apiKey: mock.apiKey });

    await client.reportRunMetrics({
      tokens_by_category: { skills: 1, tools: 2, history: 3, memory: 0, user_input: 5 },
      model: "claude-sonnet-5",
    });

    const post = mock.requests.find((r) => r.path === "/api/v1/events");
    expect(post).toBeDefined();
    expect((post?.body as Record<string, unknown>).model).toBe("claude-sonnet-5");
  });

  it("throws on a non-2xx response (all-or-nothing, host owns handling)", async () => {
    mock = await startMockCloud();
    mock.runMetricsResponder = () => ({ status: 400, payload: { error: "invalid" } });
    const client = new CloudClient({ baseUrl: mock.url, apiKey: mock.apiKey });

    await expect(
      client.reportRunMetrics({
        tokens_by_category: { skills: 0, tools: 0, history: 0, memory: 0, user_input: 0 },
      }),
    ).rejects.toThrow(/400/);
  });

  it("rejects a batch larger than 500 without calling the network", async () => {
    mock = await startMockCloud();
    const client = new CloudClient({ baseUrl: mock.url, apiKey: mock.apiKey });
    const one = {
      tokens_by_category: { skills: 0, tools: 0, history: 0, memory: 0, user_input: 0 },
    };

    await expect(client.reportRunMetrics(new Array(501).fill(one))).rejects.toThrow(/500/);
    expect(mock.requests.filter((r) => r.path === "/api/v1/events")).toHaveLength(0);
  });
});
