import { SkillCatalog } from "@ratel-ai/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CatalogSkillWire } from "./canonical.js";
import { etagOf } from "./canonical.js";
import { CloudAuthError, CloudConfigError } from "./errors.js";
import { createSkillSync, type SkillSyncHandle, syncSkills } from "./index.js";
import { type MockSource, startMockSource } from "./testing/mock-source.js";

const API_KEY = "test-key";

const skill: CatalogSkillWire = {
  id: "s1",
  name: "alpha",
  description: "First.",
  tags: ["x"],
  tools: [],
  metadata: {},
  body: "# A\n",
};

function respond200(skills: CatalogSkillWire[]): Response {
  const { hex, etag } = etagOf(skills);
  return new Response(JSON.stringify({ catalogVersion: hex, skills }), {
    status: 200,
    headers: { etag, "cache-control": "no-cache" },
  });
}

function countingFetch(respond: () => Response) {
  const calls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return respond();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

let source: MockSource;
let downUrl: string;

beforeAll(async () => {
  source = await startMockSource({ apiKey: API_KEY });
  const down = await startMockSource();
  downUrl = down.url;
  await down.close();
});

afterAll(async () => {
  await source.close();
});

const handles: SkillSyncHandle[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createSkillSync", () => {
  it("throws CloudConfigError immediately when no url is resolvable", () => {
    expect(() => createSkillSync(new SkillCatalog(), { env: {} })).toThrow(CloudConfigError);
  });

  it("resolves RATEL_URL and RATEL_API_KEY from the injected env and hydrates", async () => {
    source.setSkills([skill]);
    const catalog = new SkillCatalog();
    const handle = createSkillSync(catalog, {
      env: { RATEL_URL: source.url, RATEL_API_KEY: API_KEY },
    });
    handles.push(handle);
    await vi.waitFor(() => expect(catalog.size()).toBe(1));
    expect(handle.ownedCount).toBe(1);
    expect(handle.lastSyncedAt).toBeInstanceOf(Date);
  });

  it("prefers explicit options over env", async () => {
    source.setSkills([skill]);
    const catalog = new SkillCatalog();
    const handle = createSkillSync(catalog, {
      url: source.url,
      apiKey: API_KEY,
      env: { RATEL_URL: downUrl, RATEL_API_KEY: "wrong" },
    });
    handles.push(handle);
    await vi.waitFor(() => expect(catalog.size()).toBe(1));
  });

  it("tolerates a failed first fetch — no throw, staleness surfaced on the handle", async () => {
    const catalog = new SkillCatalog();
    const handle = createSkillSync(catalog, { url: downUrl });
    handles.push(handle);
    await vi.waitFor(() => expect(handle.consecutiveFailures).toBeGreaterThan(0));
    expect(catalog.size()).toBe(0);
    expect(handle.lastSyncedAt).toBeUndefined();
  });

  it("starts the refresh chain at the configured interval", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { fetchImpl, calls } = countingFetch(() => respond200([skill]));
    const handle = createSkillSync(new SkillCatalog(), {
      url: "http://mock.invalid",
      apiKey: API_KEY,
      intervalMs: 1000,
      fetchImpl,
    });
    handles.push(handle);
    expect(calls).toHaveLength(1); // The immediate first refresh.
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    handle.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(2);
  });

  it("defaults the interval to five minutes", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { fetchImpl, calls } = countingFetch(() => respond200([skill]));
    const handle = createSkillSync(new SkillCatalog(), {
      url: "http://mock.invalid",
      fetchImpl,
    });
    handles.push(handle);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
  });
});

describe("syncSkills", () => {
  it("throws CloudConfigError when no url is resolvable", async () => {
    await expect(syncSkills(new SkillCatalog(), { env: {} })).rejects.toBeInstanceOf(
      CloudConfigError,
    );
  });

  it("one-shot syncs and returns the SyncResult", async () => {
    source.setSkills([skill]);
    const catalog = new SkillCatalog();
    const result = await syncSkills(catalog, { url: source.url, apiKey: API_KEY });
    expect(result).toMatchObject({ added: 1, updated: 0, removed: 0, unchanged: false });
    expect(catalog.has("s1")).toBe(true);
  });

  it("throws on failure instead of tolerating it", async () => {
    await expect(
      syncSkills(new SkillCatalog(), { url: source.url, apiKey: "wrong" }),
    ).rejects.toBeInstanceOf(CloudAuthError);
  });

  it("passes the scope through to the source", async () => {
    source.setLayers({
      global: [skill],
      subjects: { alice: [{ ...skill, id: "a1", name: "alice-only" }] },
    });
    source.requests.length = 0;
    const catalog = new SkillCatalog();
    const result = await syncSkills(catalog, {
      url: source.url,
      apiKey: API_KEY,
      scope: "alice",
    });
    expect(source.requests[0]?.scope).toBe("alice");
    expect(result.added).toBe(2);
    expect(catalog.has("a1")).toBe(true);
  });
});
