import { describe, expect, it, vi } from "vitest";
import type { Event } from "./index.js";
import { sendEventBatch } from "./index.js";

function event(): Event {
  return {
    provider: "openai",
    model: "gpt-5.5",
    ts: "2026-06-30T12:00:00Z",
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const noSleep = () => Promise.resolve();

describe("sendEventBatch", () => {
  it("posts events with a bearer token and returns accepted count on 202", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(202, { accepted: 1 }));
    const result = await sendEventBatch([event()], {
      endpoint: "https://x/api/v1/events",
      apiKey: "secret",
      fetch,
      sleep: noSleep,
    });

    expect(result).toEqual({ ok: true, accepted: 1, status: 202 });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://x/api/v1/events");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body)).toHaveLength(1);
  });

  it("does nothing and reports success for an empty batch", async () => {
    const fetch = vi.fn();
    const result = await sendEventBatch([], { endpoint: "https://x", apiKey: "k", fetch });
    expect(result).toEqual({ ok: true, accepted: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries transient 5xx and then succeeds", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(202, { accepted: 1 }));
    const result = await sendEventBatch([event()], {
      endpoint: "https://x",
      apiKey: "k",
      fetch,
      baseDelayMs: 0,
      sleep: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries on network errors up to maxRetries then gives up", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const onError = vi.fn();
    const result = await sendEventBatch([event()], {
      endpoint: "https://x",
      apiKey: "k",
      fetch,
      maxRetries: 2,
      baseDelayMs: 0,
      sleep: noSleep,
      onError,
    });
    expect(result.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not retry a permanent 4xx", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad" }));
    const onError = vi.fn();
    const result = await sendEventBatch([event()], {
      endpoint: "https://x",
      apiKey: "k",
      fetch,
      baseDelayMs: 0,
      sleep: noSleep,
      onError,
    });
    expect(result).toEqual({ ok: false, accepted: 0, status: 400 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("never throws", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      sendEventBatch([event()], {
        endpoint: "https://x",
        apiKey: "k",
        fetch,
        maxRetries: 0,
        sleep: noSleep,
      }),
    ).resolves.toEqual({ ok: false, accepted: 0 });
  });
});
