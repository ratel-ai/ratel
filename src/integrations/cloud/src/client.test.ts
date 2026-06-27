import type { Rollup } from "@ratel-ai/sdk";
import { describe, expect, it, vi } from "vitest";
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
