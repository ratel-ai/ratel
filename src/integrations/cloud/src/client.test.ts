import type { Rollup } from "@ratel-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { ChatPayload } from "./client.js";
import { configure, getClient, RatelClient, setGlobalClient } from "./client.js";

describe("RatelClient", () => {
  it("tracks and flushes through the transport", async () => {
    const batches: Rollup[][] = [];
    const client = new RatelClient({
      transport: (batch) => {
        batches.push([...batch]);
      },
    });
    client.track({
      tokensByCategory: { tools: 2000 },
      savedByCategory: { tools: 7000 },
      model: "claude-haiku-4-5",
    });
    await client.flush();
    expect(batches).toHaveLength(1);
    const event = batches[0][0];
    expect(event.tokens_by_category).toEqual({
      skills: 0,
      tools: 2000,
      history: 0,
      memory: 0,
      user_input: 0,
    });
    expect((event.saved_by_category as Record<string, number>).tools).toBe(7000);
    expect(event.cost_usd as number).toBeGreaterThan(0);
  });

  it("auto-flushes at the size threshold", async () => {
    const batches: Rollup[][] = [];
    const client = new RatelClient({
      flushAt: 2,
      transport: (batch) => {
        batches.push([...batch]);
      },
    });
    client.track({ tokensByCategory: { tools: 1 } });
    client.track({ tokensByCategory: { tools: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the void flush() settle
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("is a no-op without a key or transport", async () => {
    const client = new RatelClient({ host: "https://cloud.ratel.sh" });
    client.track({ tokensByCategory: { tools: 1 } }); // must not throw
    await client.flush();
    expect(client.canExport).toBe(false);
  });

  it("never throws when the transport rejects", async () => {
    const client = new RatelClient({
      transport: () => {
        throw new Error("boom");
      },
    });
    client.track({ tokensByCategory: { tools: 1 } });
    await expect(client.flush()).resolves.toBeUndefined();
  });
});

describe("RatelClient chat capture", () => {
  it("records messages and flushes them to the chats endpoint", async () => {
    const batches: ChatPayload[][] = [];
    const client = new RatelClient({
      captureChats: true,
      chatTransport: (batch) => {
        batches.push([...batch] as ChatPayload[]);
      },
    });
    client.recordMessages("conv-1", [
      { role: "user", content: "where is my order" },
      { role: "assistant", content: "let me check" },
    ]);
    await client.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0]).toEqual({
      conversation_id: "conv-1",
      messages: [
        { role: "user", content: "where is my order", seq: 0 },
        { role: "assistant", content: "let me check", seq: 1 },
      ],
    });
  });

  it("assigns seq by array index but honours explicit seq", async () => {
    const batches: ChatPayload[][] = [];
    const client = new RatelClient({
      captureChats: true,
      chatTransport: (batch) => {
        batches.push([...batch] as ChatPayload[]);
      },
    });
    client.recordMessages("conv-seq", [
      { role: "user", content: "a", seq: 5 },
      { role: "assistant", content: "b" },
    ]);
    await client.flush();
    expect(batches[0][0].messages).toEqual([
      { role: "user", content: "a", seq: 5 },
      { role: "assistant", content: "b", seq: 1 },
    ]);
  });

  it("serializes occurredAt to snake_case occurred_at ISO strings", async () => {
    const batches: ChatPayload[][] = [];
    const client = new RatelClient({
      captureChats: true,
      chatTransport: (batch) => {
        batches.push([...batch] as ChatPayload[]);
      },
    });
    const when = new Date("2026-06-29T09:12:00.000Z");
    client.recordMessages(
      "conv-time",
      [
        { role: "user", content: "hi", occurredAt: when },
        { role: "assistant", content: "yo", occurredAt: "2026-06-29T09:12:01Z" },
      ],
      { metadata: { tenant: "acme" } },
    );
    await client.flush();
    expect(batches[0][0]).toEqual({
      conversation_id: "conv-time",
      messages: [
        { role: "user", content: "hi", seq: 0, occurred_at: "2026-06-29T09:12:00.000Z" },
        { role: "assistant", content: "yo", seq: 1, occurred_at: "2026-06-29T09:12:01Z" },
      ],
      metadata: { tenant: "acme" },
    });
  });

  it("is a no-op when captureChats is off (even with a transport)", async () => {
    const batches: ChatPayload[][] = [];
    const client = new RatelClient({
      chatTransport: (batch) => {
        batches.push([...batch] as ChatPayload[]);
      },
    });
    client.recordMessages("conv-off", [{ role: "user", content: "hi" }]);
    await client.flush();
    expect(batches).toHaveLength(0);
  });

  it("is a no-op when capture is on but there is no key or transport", async () => {
    const client = new RatelClient({ captureChats: true, host: "https://cloud.ratel.sh" });
    client.recordMessages("conv-nokey", [{ role: "user", content: "hi" }]); // must not throw
    await client.flush();
    expect(client.canExport).toBe(false);
  });

  it("never throws on bad input", async () => {
    const client = new RatelClient({
      captureChats: true,
      chatTransport: () => {},
    });
    // Intentionally malformed input from untyped callers.
    expect(() =>
      client.recordMessages(
        "conv-bad",
        undefined as unknown as Parameters<typeof client.recordMessages>[1],
      ),
    ).not.toThrow();
    expect(() => client.recordMessages("conv-bad", [])).not.toThrow();
    await expect(client.flush()).resolves.toBeUndefined();
  });

  it("skips malformed elements rather than dropping the whole batch", async () => {
    const batches: ChatPayload[][] = [];
    const client = new RatelClient({
      captureChats: true,
      chatTransport: (batch) => {
        batches.push([...batch] as ChatPayload[]);
      },
    });
    const messages = [null, { role: "user", content: "kept" }, "oops"] as unknown as Parameters<
      typeof client.recordMessages
    >[1];
    client.recordMessages("conv-mixed", messages);
    await client.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0][0].messages).toEqual([{ role: "user", content: "kept", seq: 1 }]);
  });

  it("does not ship events on the network when only a chat transport is set", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const client = new RatelClient({ captureChats: true, chatTransport: () => {} });
    client.track({ tokensByCategory: { tools: 1 } }); // no key + only chatTransport → must not POST
    await client.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("auto-flushes chats at the size threshold", async () => {
    const batches: ChatPayload[][] = [];
    const client = new RatelClient({
      captureChats: true,
      flushAt: 2,
      chatTransport: (batch) => {
        batches.push([...batch] as ChatPayload[]);
      },
    });
    client.recordMessages("c1", [{ role: "user", content: "1" }]);
    client.recordMessages("c2", [{ role: "user", content: "2" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("batches chats independently of events", async () => {
    const eventBatches: Rollup[][] = [];
    const chatBatches: ChatPayload[][] = [];
    const client = new RatelClient({
      captureChats: true,
      transport: (batch) => {
        eventBatches.push([...batch]);
      },
      chatTransport: (batch) => {
        chatBatches.push([...batch] as ChatPayload[]);
      },
    });
    client.track({ tokensByCategory: { tools: 1 } });
    client.recordMessages("conv-x", [{ role: "user", content: "hi" }]);
    await client.flush();
    expect(eventBatches).toHaveLength(1);
    expect(eventBatches[0]).toHaveLength(1);
    expect(chatBatches).toHaveLength(1);
    expect(chatBatches[0]).toHaveLength(1);
  });

  it("trackConversation returns a handle that records and flushes", async () => {
    const batches: ChatPayload[][] = [];
    const client = new RatelClient({
      captureChats: true,
      chatTransport: (batch) => {
        batches.push([...batch] as ChatPayload[]);
      },
    });
    const conv = client.trackConversation("conv-handle");
    conv.record([{ role: "user", content: "first" }]);
    conv.record([{ role: "assistant", content: "second" }]);
    await conv.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0][0].conversation_id).toBe("conv-handle");
    expect(batches[0][1].conversation_id).toBe("conv-handle");
  });

  it("can be enabled via RATEL_CAPTURE_CHATS without an explicit flag", async () => {
    const batches: ChatPayload[][] = [];
    vi.stubEnv("RATEL_CAPTURE_CHATS", "true");
    try {
      const client = new RatelClient({
        chatTransport: (batch) => {
          batches.push([...batch] as ChatPayload[]);
        },
      });
      client.recordMessages("conv-env", [{ role: "user", content: "hi" }]);
      await client.flush();
      expect(batches).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("POSTs chats to /api/v1/chats with a bearer token (default fetch path)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const client = new RatelClient({
      apiKey: "rk-test",
      captureChats: true,
      flushIntervalMs: 10_000,
      timeoutMs: 100,
    });
    client.recordMessages("conv-net", [{ role: "user", content: "hi" }]);
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cloud.ratel.sh/api/v1/chats");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer rk-test");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual([
      { conversation_id: "conv-net", messages: [{ role: "user", content: "hi", seq: 0 }] },
    ]);
    await client.shutdown();
    vi.unstubAllGlobals();
  });
});

describe("getClient / configure / setGlobalClient", () => {
  it("getClient returns a process-wide singleton", () => {
    setGlobalClient(null);
    expect(getClient()).toBe(getClient());
    setGlobalClient(null);
  });

  it("configure replaces the global client", () => {
    setGlobalClient(null);
    const first = getClient();
    const second = configure({ apiKey: "rk-test" });
    expect(second).not.toBe(first);
    expect(getClient()).toBe(second);
    setGlobalClient(null);
  });
});

describe("RatelClient background flush", () => {
  it("auto-flushes shortly after track, with no explicit flush", async () => {
    const batches: Rollup[][] = [];
    const client = new RatelClient({
      transport: (batch) => {
        batches.push([...batch]);
      },
      flushIntervalMs: 10,
    });
    client.track({ tokensByCategory: { tools: 1 } });
    expect(batches).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(batches).toHaveLength(1);
  });

  it("shutdown ships what is still buffered", async () => {
    const batches: Rollup[][] = [];
    const client = new RatelClient({
      transport: (batch) => {
        batches.push([...batch]);
      },
      flushIntervalMs: 10_000,
    });
    client.track({ tokensByCategory: { tools: 5 } });
    await client.shutdown();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });
});

describe("RatelClient transport reliability", () => {
  it("drops everything at sampleRate 0", async () => {
    const batches: Rollup[][] = [];
    const client = new RatelClient({
      transport: (batch) => {
        batches.push([...batch]);
      },
      sampleRate: 0,
    });
    client.track({ tokensByCategory: { tools: 1 } });
    await client.flush();
    expect(batches).toHaveLength(0);
  });

  it("retries on 5xx then succeeds (default fetch path)", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return { ok: calls >= 2, status: calls >= 2 ? 202 : 500 } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new RatelClient({ apiKey: "rk-test", flushIntervalMs: 10_000, timeoutMs: 100 });
    client.track({ tokensByCategory: { tools: 1 } });
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await client.shutdown();
    vi.unstubAllGlobals();
  });

  it("drops on 4xx without retry and warns once (default fetch path)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new RatelClient({ apiKey: "rk-test", flushIntervalMs: 10_000 });
    client.track({ tokensByCategory: { tools: 1 } });
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    await client.shutdown();
    vi.unstubAllGlobals();
  });
});
