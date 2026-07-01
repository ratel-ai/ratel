import { describe, expect, it, vi } from "vitest";
import type { Event } from "./index.js";
import { RatelCloud } from "./index.js";

function event(): Event {
  return {
    provider: "openai",
    model: "gpt-5.5",
    ts: "2026-06-30T12:00:00Z",
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  };
}

function okFetch() {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ accepted: 1 }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("RatelCloud", () => {
  it("does not send on record; sends a batched array on flush", async () => {
    const fetch = okFetch();
    const cloud = new RatelCloud({ endpoint: "https://x", apiKey: "k", flushIntervalMs: 0, fetch });

    cloud.record(event());
    cloud.record(event());
    expect(fetch).not.toHaveBeenCalled();

    await cloud.flush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toHaveLength(2);
  });

  it("auto-flushes when the queue reaches batchSize", async () => {
    const fetch = okFetch();
    const cloud = new RatelCloud({
      endpoint: "https://x",
      apiKey: "k",
      flushIntervalMs: 0,
      batchSize: 2,
      fetch,
    });

    cloud.record(event());
    cloud.record(event()); // hits batchSize → triggers flush
    await cloud.close();

    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toHaveLength(2);
  });

  it("drops invalid events and reports them, without enqueuing", async () => {
    const fetch = okFetch();
    const onError = vi.fn();
    const cloud = new RatelCloud({
      endpoint: "https://x",
      apiKey: "k",
      flushIntervalMs: 0,
      fetch,
      onError,
    });

    cloud.record({ ...event(), provider: "" });
    await cloud.flush();

    expect(onError).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("flushes remaining events on close", async () => {
    const fetch = okFetch();
    const cloud = new RatelCloud({ endpoint: "https://x", apiKey: "k", flushIntervalMs: 0, fetch });
    cloud.record(event());
    await cloud.close();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stamps ts with the current time when omitted", async () => {
    const fetch = okFetch();
    const cloud = new RatelCloud({
      endpoint: "https://x",
      apiKey: "k",
      flushIntervalMs: 0,
      fetch,
      now: () => "2026-07-01T00:00:00Z",
    });

    const { ts: _ts, ...withoutTs } = event();
    cloud.record(withoutTs);
    await cloud.flush();

    expect(JSON.parse(fetch.mock.calls[0][1].body)[0].ts).toBe("2026-07-01T00:00:00Z");
  });

  it("preserves an explicit ts rather than stamping", async () => {
    const fetch = okFetch();
    const cloud = new RatelCloud({
      endpoint: "https://x",
      apiKey: "k",
      flushIntervalMs: 0,
      fetch,
      now: () => "2026-07-01T00:00:00Z",
    });

    cloud.record(event()); // ts: "2026-06-30T12:00:00Z"
    await cloud.flush();

    expect(JSON.parse(fetch.mock.calls[0][1].body)[0].ts).toBe("2026-06-30T12:00:00Z");
  });

  it("splits a large queue into MAX_BATCH-bounded requests", async () => {
    const fetch = okFetch();
    const cloud = new RatelCloud({
      endpoint: "https://x",
      apiKey: "k",
      flushIntervalMs: 0,
      batchSize: 500,
      fetch,
    });
    for (let i = 0; i < 1100; i++) cloud.record(event());
    await cloud.flush();
    // 1100 events / 500 per batch → 3 requests.
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
