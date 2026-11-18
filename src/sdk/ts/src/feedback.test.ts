import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { experimentalFeedback } from "./feedback.js";
import * as sdk from "./index.js";
import { runInTurn } from "./turn.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const TURN_ID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const ENV_KEYS = ["RATEL_API_KEY", "RATEL_OTLP_ENDPOINT", "RATEL_URL"] as const;

const okBody = {
  received: 1,
  accepted: 1,
  duplicate: 0,
  rejected: 0,
  results: [{ index: 0, status: "accepted", id: "fb_1" }],
};

function fakeFetch(response: () => Promise<Response> = async () => Response.json(okBody)) {
  return vi.fn<typeof fetch>(async () => response());
}

function sentRequest(fetchMock: ReturnType<typeof fakeFetch>) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  return {
    url: String(url),
    init: init as RequestInit,
    body: JSON.parse(String((init as RequestInit).body)) as {
      feedback: Record<string, unknown>[];
    },
  };
}

describe("experimentalFeedback", () => {
  const saved: Record<string, string | undefined> = {};
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    warn.mockRestore();
    trace.disable();
    context.disable();
  });

  it("is exported from the package entry point", () => {
    expect(sdk.experimentalFeedback).toBe(experimentalFeedback);
  });

  it("POSTs one item in the contract shape with the auth and sdk headers", async () => {
    const fetchMock = fakeFetch();
    const result = await experimentalFeedback({
      name: "thumbs",
      value: false,
      traceId: TRACE_ID,
      apiKey: "rk_test",
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const { url, init, body } = sentRequest(fetchMock);
    expect(url).toBe("https://cloud.ratel.sh/api/v1/feedback");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer rk_test");
    expect(headers.get("x-ratel-sdk")).toMatch(/^@ratel-ai\/sdk\/\S+$/);
    expect(Object.keys(body)).toEqual(["feedback"]);
    expect(body.feedback).toHaveLength(1);
    const item = body.feedback[0] as Record<string, unknown>;
    expect(item).toEqual({
      idempotency_key: expect.stringMatching(UUID),
      trace_id: TRACE_ID,
      name: "thumbs",
      value: false,
      observed_at: expect.any(String),
    });
    expect(new Date(String(item.observed_at)).toISOString()).toBe(item.observed_at);
    expect(result).toEqual({
      ok: true,
      status: 200,
      accepted: 1,
      duplicate: 0,
      rejected: 0,
      body: okBody,
    });
  });

  it("sends every optional field in snake_case and keeps the caller's key and time", async () => {
    const fetchMock = fakeFetch();
    await experimentalFeedback({
      name: "rating",
      value: 4,
      spanId: "b7ad6b7169203331",
      turnId: TURN_ID,
      sessionId: "sess-1",
      endUserId: "user-1",
      comment: "nice",
      metadata: { channel: "web" },
      observedAt: new Date("2026-11-01T10:00:00.000Z"),
      idempotencyKey: "key-1",
      apiKey: "rk_test",
      fetch: fetchMock,
    });

    expect(sentRequest(fetchMock).body.feedback[0]).toEqual({
      idempotency_key: "key-1",
      span_id: "b7ad6b7169203331",
      turn_id: TURN_ID,
      session_id: "sess-1",
      end_user_id: "user-1",
      name: "rating",
      value: 4,
      comment: "nice",
      metadata: { channel: "web" },
      observed_at: "2026-11-01T10:00:00.000Z",
    });
  });

  describe("ambient defaults", () => {
    it("fills turn_id and end_user_id from the active turn", async () => {
      const fetchMock = fakeFetch();
      await runInTurn({ id: TURN_ID, endUserId: "user-7" }, () =>
        experimentalFeedback({ name: "thumbs", value: true, apiKey: "k", fetch: fetchMock }),
      );

      const item = sentRequest(fetchMock).body.feedback[0];
      expect(item?.turn_id).toBe(TURN_ID);
      expect(item?.end_user_id).toBe("user-7");
    });

    it("lets explicit ids win over the active turn", async () => {
      const fetchMock = fakeFetch();
      const explicitTurn = "2c5f39cb-3fa1-41d2-983f-0016d3cca427";
      await runInTurn({ id: TURN_ID, endUserId: "user-7" }, () =>
        experimentalFeedback({
          name: "thumbs",
          value: true,
          turnId: explicitTurn,
          endUserId: "user-9",
          apiKey: "k",
          fetch: fetchMock,
        }),
      );

      const item = sentRequest(fetchMock).body.feedback[0];
      expect(item?.turn_id).toBe(explicitTurn);
      expect(item?.end_user_id).toBe("user-9");
    });

    it("does not send an active turn id that is not a UUID, but keeps its end user", async () => {
      const fetchMock = fakeFetch();
      await runInTurn({ id: "01JD0000000000000000000000", endUserId: "user-7" }, () =>
        experimentalFeedback({ name: "thumbs", value: true, apiKey: "k", fetch: fetchMock }),
      );

      const item = sentRequest(fetchMock).body.feedback[0];
      expect(item).not.toHaveProperty("turn_id");
      expect(item?.end_user_id).toBe("user-7");
    });

    it("fills trace_id and span_id from the active OTel span, explicit ids win", async () => {
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      trace.setGlobalTracerProvider(new BasicTracerProvider());
      const fetchMock = fakeFetch();
      const span = trace.getTracer("host").startSpan("request");
      const { traceId, spanId } = span.spanContext();
      await context.with(trace.setSpan(context.active(), span), async () => {
        await experimentalFeedback({ name: "thumbs", value: true, apiKey: "k", fetch: fetchMock });
        await experimentalFeedback({
          name: "thumbs",
          value: true,
          traceId: TRACE_ID,
          apiKey: "k",
          fetch: fetchMock,
        });
      });
      span.end();

      const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).feedback[0];
      const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).feedback[0];
      expect(first).toMatchObject({ trace_id: traceId, span_id: spanId });
      expect(second).toMatchObject({ trace_id: TRACE_ID, span_id: spanId });
    });
  });

  describe("validation throws synchronously before any request", () => {
    const fetchMock = fakeFetch();
    const base = { name: "thumbs", value: true, apiKey: "k", fetch: fetchMock } as const;

    beforeEach(() => fetchMock.mockClear());

    it("rejects an item with no link and names the five link fields", () => {
      expect(() => experimentalFeedback({ ...base })).toThrow(
        /traceId.*spanId.*turnId.*sessionId.*endUserId/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a missing api key", () => {
      expect(() =>
        experimentalFeedback({ name: "thumbs", value: true, traceId: TRACE_ID, fetch: fetchMock }),
      ).toThrow(/RATEL_API_KEY/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ["an empty name", { name: "  " }, /name/],
      ["an object value", { value: {} as unknown as string }, /value/],
      ["a non-finite value", { value: Number.NaN }, /value/],
      ["a missing value", { value: undefined as unknown as string }, /value/],
      ["a non-UUID turnId", { turnId: "turn-1" }, /turnId.*UUID/],
      ["array metadata", { metadata: [] as unknown as Record<string, unknown> }, /metadata/],
      ["an invalid observedAt", { observedAt: "not a date" }, /observedAt/],
    ])("rejects %s", (_label, override, message) => {
      expect(() => experimentalFeedback({ ...base, traceId: TRACE_ID, ...override })).toThrow(
        message,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("failures resolve, never reject", () => {
    it("resolves ok:false on a network error and warns", async () => {
      const fetchMock = fakeFetch(async () => {
        throw new TypeError("fetch failed");
      });
      const result = await experimentalFeedback({
        name: "thumbs",
        value: true,
        traceId: TRACE_ID,
        apiKey: "k",
        fetch: fetchMock,
      });

      expect(result).toEqual({ ok: false, error: expect.stringContaining("fetch failed") });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^ratel: feedback .*fetch failed/));
    });

    it("resolves ok:false with the status on a 500", async () => {
      const fetchMock = fakeFetch(async () => new Response("boom", { status: 500 }));
      const result = await experimentalFeedback({
        name: "thumbs",
        value: true,
        traceId: TRACE_ID,
        apiKey: "k",
        fetch: fetchMock,
      });

      expect(result).toMatchObject({ ok: false, status: 500 });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^ratel: feedback .*500/));
    });

    it("resolves ok:false when the request times out", async () => {
      const fetchMock = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );
      const result = await experimentalFeedback({
        name: "thumbs",
        value: true,
        traceId: TRACE_ID,
        apiKey: "k",
        fetch: fetchMock,
        timeoutMs: 5,
      });

      expect(result).toMatchObject({ ok: false });
    });

    it("warns with the reason when the server rejects the item", async () => {
      const rejectedBody = {
        received: 1,
        accepted: 0,
        duplicate: 0,
        rejected: 1,
        results: [{ index: 0, status: "rejected", reason: "no_value" }],
      };
      const fetchMock = fakeFetch(async () => Response.json(rejectedBody));
      const result = await experimentalFeedback({
        name: "thumbs",
        value: true,
        traceId: TRACE_ID,
        apiKey: "k",
        fetch: fetchMock,
      });

      expect(result).toMatchObject({ ok: true, rejected: 1 });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no_value/));
    });
  });

  describe("base URL and api key from the environment", () => {
    const send = (fetchMock: ReturnType<typeof fakeFetch>, endpoint?: string) =>
      experimentalFeedback({
        name: "thumbs",
        value: true,
        traceId: TRACE_ID,
        fetch: fetchMock,
        ...(endpoint === undefined ? {} : { endpoint }),
      });

    beforeEach(() => {
      process.env.RATEL_API_KEY = "rk_env";
    });

    it("reads the api key from RATEL_API_KEY", async () => {
      const fetchMock = fakeFetch();
      await send(fetchMock);
      expect(new Headers(sentRequest(fetchMock).init.headers).get("authorization")).toBe(
        "Bearer rk_env",
      );
    });

    it("prefers the endpoint option over every env var", async () => {
      process.env.RATEL_OTLP_ENDPOINT = "https://otlp.example/v1/traces";
      process.env.RATEL_URL = "https://legacy.example";
      const fetchMock = fakeFetch();
      await send(fetchMock, "https://custom.example/");
      expect(sentRequest(fetchMock).url).toBe("https://custom.example/api/v1/feedback");
    });

    it("strips /v1/traces from RATEL_OTLP_ENDPOINT and keeps a path prefix", async () => {
      process.env.RATEL_OTLP_ENDPOINT = "https://otlp.example/ratel/v1/traces";
      process.env.RATEL_URL = "https://legacy.example";
      const fetchMock = fakeFetch();
      await send(fetchMock);
      expect(sentRequest(fetchMock).url).toBe("https://otlp.example/ratel/api/v1/feedback");
    });

    it("falls back to RATEL_URL", async () => {
      process.env.RATEL_URL = "https://legacy.example/v1/traces";
      const fetchMock = fakeFetch();
      await send(fetchMock);
      expect(sentRequest(fetchMock).url).toBe("https://legacy.example/api/v1/feedback");
    });

    it("defaults to Ratel Cloud", async () => {
      const fetchMock = fakeFetch();
      await send(fetchMock);
      expect(sentRequest(fetchMock).url).toBe("https://cloud.ratel.sh/api/v1/feedback");
    });
  });
});
