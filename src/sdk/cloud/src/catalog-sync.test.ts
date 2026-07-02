import { SkillCatalog } from "@ratel-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { CloudAuthError, CloudClient } from "./index.js";
import { type MockCloud, startMockCloud } from "./testing/mock-cloud.js";
import type { CatalogSkillWire } from "./types.js";

const apiDesign: CatalogSkillWire = {
  id: "api-design",
  name: "api-design",
  description: "REST API design patterns: resource naming, status codes, pagination.",
  tags: ["backend", "api"],
  tools: [],
  metadata: {},
  body: "# API Design",
};

const slides: CatalogSkillWire = {
  id: "frontend-slides",
  name: "frontend-slides",
  description: "Build animation-rich HTML presentations from scratch.",
  tags: ["frontend"],
  tools: [],
  metadata: {},
  body: "# Slides",
};

let mock: MockCloud;

afterEach(async () => {
  await mock?.close();
});

function client(): CloudClient {
  return new CloudClient({ baseUrl: mock.url, apiKey: mock.apiKey });
}

describe("CloudClient.fetchCatalog", () => {
  it("returns the published skills with an etag, then 304 on the same etag", async () => {
    mock = await startMockCloud({ skills: [apiDesign], version: "v1" });
    const c = client();

    const first = await c.fetchCatalog();
    expect(first.status).toBe("changed");
    if (first.status !== "changed") throw new Error("unreachable");
    expect(first.catalogVersion).toBe("v1");
    expect(first.skills.map((s) => s.id)).toEqual(["api-design"]);

    const second = await c.fetchCatalog(first.etag);
    expect(second.status).toBe("unchanged");
  });

  it("maps a rejected key to CloudAuthError", async () => {
    mock = await startMockCloud();
    const bad = new CloudClient({ baseUrl: mock.url, apiKey: "rtl_wrong" });
    await expect(bad.fetchCatalog()).rejects.toBeInstanceOf(CloudAuthError);
  });
});

describe("CloudClient.syncSkills", () => {
  it("registers the published catalog into a live SkillCatalog", async () => {
    mock = await startMockCloud({ skills: [apiDesign, slides], version: "v1" });
    const catalog = new SkillCatalog();

    const sync = await client().syncSkills(catalog);

    expect(catalog.size()).toBe(2);
    expect(catalog.search("REST API pagination", 5)[0]?.skillId).toBe("api-design");
    expect(sync.catalogVersion).toBe("v1");
  });

  it("applies adds, updates and removes on refresh, reusing the etag", async () => {
    mock = await startMockCloud({ skills: [apiDesign], version: "v1" });
    const catalog = new SkillCatalog();
    const sync = await client().syncSkills(catalog);

    const noop = await sync.refresh();
    expect(noop.changed).toBe(false);

    mock.setSkills([{ ...apiDesign, description: "GraphQL schema modeling." }, slides], "v2");
    const result = await sync.refresh();
    expect(result.changed).toBe(true);
    expect(result.updated).toEqual(["api-design"]);
    expect(result.added).toEqual(["frontend-slides"]);
    expect(catalog.search("GraphQL schema", 5)[0]?.skillId).toBe("api-design");

    mock.setSkills([slides], "v3");
    const removal = await sync.refresh();
    expect(removal.removed).toEqual(["api-design"]);
    expect(catalog.has("api-design")).toBe(false);
    expect(catalog.has("frontend-slides")).toBe(true);
  });

  it("an idempotent resync applies nothing and emits zero churn", async () => {
    mock = await startMockCloud({ skills: [apiDesign], version: "v1" });
    const catalog = new SkillCatalog({ trace: { kind: "memory", sessionId: "t" } });
    const sync = await client().syncSkills(catalog);
    catalog.drainTraceEvents();

    // Same content, new version marker: fetch is a 200, but no skill differs.
    mock.setSkills([{ ...apiDesign }], "v2");
    const result = await sync.refresh();

    expect(result.changed).toBe(true);
    expect(result.updated).toEqual([]);
    const churn = (catalog.drainTraceEvents() as Array<Record<string, unknown>>).filter(
      (e) => e.type === "skill_churn",
    );
    expect(churn).toEqual([]);
  });

  it("never clobbers a host-registered skill; reports it as a conflict", async () => {
    mock = await startMockCloud({ skills: [apiDesign], version: "v1" });
    const catalog = new SkillCatalog();
    const hostSkill = {
      id: "api-design",
      name: "api-design",
      description: "the host's own take on API design",
    };
    catalog.register(hostSkill);

    const sync = await client().syncSkills(catalog);

    const result = await (async () => {
      mock.setSkills([{ ...apiDesign, description: "changed again" }], "v2");
      return sync.refresh();
    })();
    expect(result.conflicts).toEqual(["api-design"]);
    expect(catalog.get("api-design")?.description).toBe("the host's own take on API design");
  });

  it("fires onCatalogVersionChange once per version change", async () => {
    mock = await startMockCloud({ skills: [apiDesign], version: "v1" });
    const versions: string[] = [];
    const catalog = new SkillCatalog();
    const sync = await client().syncSkills(catalog, {
      onCatalogVersionChange: (v) => versions.push(v),
    });

    await sync.refresh(); // unchanged
    mock.setSkills([apiDesign, slides], "v2");
    await sync.refresh();

    expect(versions).toEqual(["v1", "v2"]);
  });

  it("stamps catalog_version onto a wired TraceSession's envelopes", async () => {
    const { ToolCatalog, TraceSession } = await import("@ratel-ai/sdk");
    mock = await startMockCloud({ skills: [apiDesign], version: "v1" });
    const session = new TraceSession({ sessionId: "s" });
    const tools = new ToolCatalog({ traceSession: session });
    const catalog = new SkillCatalog();

    await client().syncSkills(catalog, { traceSession: session });
    tools.recordEvent({ type: "auth_needs", upstream: "x" });

    const events = session.drain() as Array<Record<string, unknown>>;
    expect(events.at(-1)?.catalog_version).toBe("v1");
  });

  it("createSkillSync tolerates an offline start; refresh surfaces the failure", async () => {
    mock = await startMockCloud();
    const catalog = new SkillCatalog();
    const offline = new CloudClient({ baseUrl: "http://127.0.0.1:9", apiKey: "rtl_x" });

    const sync = offline.createSkillSync(catalog);
    await expect(sync.refresh()).rejects.toThrow(/unreachable/);
    expect(catalog.size()).toBe(0);
  });

  it("requires baseUrl and apiKey (env or options)", async () => {
    mock = await startMockCloud();
    const prevUrl = process.env.RATEL_CLOUD_URL;
    const prevKey = process.env.RATEL_CLOUD_API_KEY;
    delete process.env.RATEL_CLOUD_URL;
    delete process.env.RATEL_CLOUD_API_KEY;
    try {
      expect(() => new CloudClient()).toThrow(/base URL missing/);
      expect(() => new CloudClient({ baseUrl: mock.url })).toThrow(/API key missing/);
      process.env.RATEL_CLOUD_URL = mock.url;
      process.env.RATEL_CLOUD_API_KEY = mock.apiKey;
      expect(() => new CloudClient()).not.toThrow();
    } finally {
      if (prevUrl === undefined) delete process.env.RATEL_CLOUD_URL;
      else process.env.RATEL_CLOUD_URL = prevUrl;
      if (prevKey === undefined) delete process.env.RATEL_CLOUD_API_KEY;
      else process.env.RATEL_CLOUD_API_KEY = prevKey;
    }
  });
});
