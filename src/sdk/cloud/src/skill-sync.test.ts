import { SkillCatalog } from "@ratel-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogSkillWire } from "./canonical.js";
import { etagOf } from "./canonical.js";
import { SkillSync, type SyncResult } from "./skill-sync.js";

const wire = (id: string, over: Partial<CatalogSkillWire> = {}): CatalogSkillWire => ({
  id,
  name: `${id}-name`,
  description: `${id} description`,
  tags: ["t"],
  tools: [],
  metadata: {},
  body: `# ${id}\n`,
  ...over,
});

function respond200(skills: CatalogSkillWire[]): Response {
  const { hex, etag } = etagOf(skills);
  return new Response(JSON.stringify({ catalogVersion: hex, skills }), {
    status: 200,
    headers: { etag, "cache-control": "no-cache" },
  });
}

function respondError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: "boom" } }), { status });
}

/** A scripted fetch stub: shifts through `script`, repeating the last entry. */
function scriptedFetch(script: (() => Response | Error)[]) {
  const calls: { ifNoneMatch: string | null }[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ ifNoneMatch: headers["if-none-match"] ?? null });
    const step = script.length > 1 ? script.shift() : script[0];
    if (!step) throw new Error("scripted fetch exhausted");
    const out = step();
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const config = { url: "http://mock.invalid", apiKey: "k" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SkillSync.refresh", () => {
  it("hydrates the catalog and projects wire skills to the 7 fields", async () => {
    const catalog = new SkillCatalog();
    const noisy = { ...wire("a"), extra: "noise" } as CatalogSkillWire;
    const { fetchImpl } = scriptedFetch([() => respond200([noisy, wire("b")])]);
    const sync = new SkillSync(catalog, config, { fetchImpl });

    const result = await sync.refresh();
    expect(result).toEqual<SyncResult>({
      added: 2,
      updated: 0,
      removed: 0,
      conflicts: [],
      unchanged: false,
    });
    expect(catalog.size()).toBe(2);
    expect(catalog.get("a")).not.toHaveProperty("extra");
    expect(sync.ownedCount).toBe(2);
    expect(sync.lastSyncedAt).toBeInstanceOf(Date);
    expect(sync.consecutiveFailures).toBe(0);
  });

  it("coalesces concurrent refresh calls on the in-flight promise", async () => {
    const catalog = new SkillCatalog();
    const { fetchImpl, calls } = scriptedFetch([() => respond200([wire("a")])]);
    const sync = new SkillSync(catalog, config, { fetchImpl });

    const [r1, r2] = await Promise.all([sync.refresh(), sync.refresh()]);
    expect(r1).toBe(r2);
    expect(calls).toHaveLength(1);
  });

  it("emits zero churn on a full resync of identical data", async () => {
    const catalog = new SkillCatalog();
    const { fetchImpl } = scriptedFetch([() => respond200([wire("a"), wire("b")])]);
    const sync = new SkillSync(catalog, config, { fetchImpl });
    await sync.refresh();

    const spy = vi.fn();
    catalog.onChange(spy);
    const result = await sync.refresh();
    expect(spy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ added: 0, updated: 0, removed: 0, conflicts: [] });
  });

  it("upserts only the skill whose 7-field projection changed", async () => {
    const catalog = new SkillCatalog();
    const { fetchImpl } = scriptedFetch([
      () => respond200([wire("a"), wire("b")]),
      () => respond200([wire("a", { body: "changed\n" }), wire("b")]),
    ]);
    const sync = new SkillSync(catalog, config, { fetchImpl });
    await sync.refresh();

    const result = await sync.refresh();
    expect(result).toMatchObject({ added: 0, updated: 1, removed: 0 });
    expect(catalog.get("a")?.body).toBe("changed\n");
  });

  it("removes and disowns an owned id that left the wire", async () => {
    const catalog = new SkillCatalog();
    const { fetchImpl } = scriptedFetch([
      () => respond200([wire("a"), wire("b")]),
      () => respond200([wire("b")]),
    ]);
    const sync = new SkillSync(catalog, config, { fetchImpl });
    await sync.refresh();

    const result = await sync.refresh();
    expect(result).toMatchObject({ added: 0, updated: 0, removed: 1 });
    expect(catalog.has("a")).toBe(false);
    expect(sync.ownedCount).toBe(1);
  });

  it("never touches a host-registered skill with a colliding id — records a conflict", async () => {
    const catalog = new SkillCatalog();
    catalog.register({ id: "a", name: "host-owned", description: "host", body: "host body" });
    const { fetchImpl } = scriptedFetch([() => respond200([wire("a"), wire("b")])]);
    const sync = new SkillSync(catalog, config, { fetchImpl });

    const result = await sync.refresh();
    expect(result).toMatchObject({ added: 1, conflicts: ["a"] });
    expect(catalog.get("a")?.name).toBe("host-owned");
    expect(sync.ownedCount).toBe(1);

    // The conflicting id is never disowned into a removal either.
    const again = await sync.refresh();
    expect(again.conflicts).toEqual(["a"]);
    expect(catalog.get("a")?.name).toBe("host-owned");
  });

  it("treats a 304 as a revalidated no-op that still refreshes lastSyncedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const catalog = new SkillCatalog();
    const { fetchImpl, calls } = scriptedFetch([
      () => respond200([wire("a")]),
      () => new Response(null, { status: 304 }),
    ]);
    const sync = new SkillSync(catalog, config, { fetchImpl });
    await sync.refresh();
    const first = sync.lastSyncedAt;

    vi.setSystemTime(2_000_000);
    const result = await sync.refresh();
    expect(result).toEqual<SyncResult>({
      added: 0,
      updated: 0,
      removed: 0,
      conflicts: [],
      unchanged: true,
    });
    expect(calls[1]?.ifNoneMatch).toBe(etagOf([wire("a")]).etag);
    expect(sync.lastSyncedAt?.getTime()).toBeGreaterThan(first?.getTime() ?? Infinity);
    expect(catalog.has("a")).toBe(true);
  });

  it("keeps the replica and counts consecutive failures on transient errors", async () => {
    const catalog = new SkillCatalog();
    const { fetchImpl } = scriptedFetch([
      () => respond200([wire("a")]),
      () => respondError(503, "unavailable"),
      () => new TypeError("fetch failed"),
      () => respond200([wire("a")]),
    ]);
    const sync = new SkillSync(catalog, config, { fetchImpl });
    await sync.refresh();

    await expect(sync.refresh()).rejects.toThrow();
    expect(sync.consecutiveFailures).toBe(1);
    await expect(sync.refresh()).rejects.toThrow();
    expect(sync.consecutiveFailures).toBe(2);
    expect(catalog.has("a")).toBe(true);

    await sync.refresh();
    expect(sync.consecutiveFailures).toBe(0);
  });
});

describe("SkillSync.start/stop", () => {
  it("schedules a setTimeout chain with ±10% jitter", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0); // low edge: 0.9 × interval
    const catalog = new SkillCatalog();
    const { fetchImpl, calls } = scriptedFetch([() => respond200([wire("a")])]);
    const sync = new SkillSync(catalog, config, { fetchImpl });

    sync.start(1000);
    await vi.advanceTimersByTimeAsync(899);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);

    random.mockReturnValue(1); // high edge: 1.1 × interval
    await vi.advanceTimersByTimeAsync(1099);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    sync.stop();
  });

  it("keeps the chain alive across transient failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const catalog = new SkillCatalog();
    const { fetchImpl, calls } = scriptedFetch([() => respondError(503, "unavailable")]);
    const sync = new SkillSync(catalog, config, { fetchImpl });

    sync.start(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(3);
    expect(sync.consecutiveFailures).toBe(3);
    expect(sync.stopped).toBe(false);
    sync.stop();
  });

  it("stops the chain permanently on an auth error and surfaces the stopped state", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const catalog = new SkillCatalog();
    const { fetchImpl, calls } = scriptedFetch([() => respondError(401, "unauthorized")]);
    const sync = new SkillSync(catalog, config, { fetchImpl });

    sync.start(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(sync.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
  });

  it("stop() is idempotent and cancels the pending timer", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const catalog = new SkillCatalog();
    const { fetchImpl, calls } = scriptedFetch([() => respond200([wire("a")])]);
    const sync = new SkillSync(catalog, config, { fetchImpl });

    sync.start(1000);
    sync.stop();
    sync.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
  });

  it("unrefs the timer so the chain never holds the process open", () => {
    const unref = vi.fn();
    const cleared: unknown[] = [];
    const handle = { unref };
    vi.stubGlobal(
      "setTimeout",
      vi.fn(() => handle),
    );
    vi.stubGlobal(
      "clearTimeout",
      vi.fn((t: unknown) => cleared.push(t)),
    );
    const catalog = new SkillCatalog();
    const { fetchImpl } = scriptedFetch([() => respond200([wire("a")])]);
    const sync = new SkillSync(catalog, config, { fetchImpl });

    sync.start(1000);
    expect(unref).toHaveBeenCalledTimes(1);
    sync.stop();
    expect(cleared).toEqual([handle]);
  });
});
