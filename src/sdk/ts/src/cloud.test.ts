import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudError, type ExecutableTool, ratel, ToolCatalog } from "./index.js";

const KEY_ENV = "RATEL_SDK_TS_CLOUD_TEST_KEY";

interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** A stand-in for Ratel Cloud: `PUT /api/v1/catalog/snapshot` and
 * `POST /v1/tools/pick`. Picks answer from a script, or with the synced
 * tools in reverse id order. */
class MockCloud {
  readonly seen: Seen[] = [];
  readonly picks: { status: number; body: unknown; headers?: Record<string, string> }[] = [];
  readonly syncs: { status: number; body: unknown }[] = [];
  private synced: string[] = [];
  private server!: Server;
  url = "";

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const body = JSON.parse(await readBody(req));
      this.seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });
      let reply: { status: number; body: unknown; headers?: Record<string, string> };
      if (req.url === "/api/v1/catalog/snapshot") {
        reply = this.syncs.shift() ?? {
          status: 200,
          body: {
            sourceId: body.source_id,
            catalogVersion: `v${this.seen.length}`,
            tools: body.tools.length,
            unchanged: false,
          },
        };
        if (reply.status === 200) this.synced = body.tools.map((t: { id: string }) => t.id);
      } else {
        reply = this.picks.shift() ?? {
          status: 200,
          body: {
            mode: body.mode,
            tools: [...this.synced]
              .sort()
              .reverse()
              .slice(0, body.top_k)
              .map((id, i) => ({ id, name: id, description: "", score: 0.9 - i * 0.1 })),
            confident: body.mode === "instant" ? null : true,
            usage: { candidates: this.synced.length, questions: 1, input_tokens: 10 },
          },
        };
      }
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
  }

  of(path: string): Seen[] {
    return this.seen.filter((s) => s.path === path);
  }

  reset(): void {
    this.seen.length = 0;
    this.picks.length = 0;
    this.syncs.length = 0;
    this.synced = [];
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data || "{}"));
  });
}

function tool(id: string, description = `does ${id}`): ExecutableTool {
  return {
    id,
    name: id,
    description,
    inputSchema: {},
    outputSchema: {},
    execute: async () => "ok",
  };
}

const SNAPSHOT = "/api/v1/catalog/snapshot";
const PICK = "/v1/tools/pick";
const mock = new MockCloud();

beforeAll(async () => {
  process.env[KEY_ENV] = "cloud-token";
  await mock.start();
});
afterAll(async () => {
  await mock.stop();
});
beforeEach(() => {
  mock.reset();
});

function catalog(cloud: Record<string, unknown> = {}): ToolCatalog {
  return new ToolCatalog({
    cloud: { url: mock.url, apiKeyEnv: KEY_ENV, sourceId: "svc", ...cloud },
  });
}

describe("ToolCatalog cloud: sync", () => {
  it("uploads an executor-free snapshot on register", async () => {
    const c = catalog();
    await c.register([tool("refund"), tool("charge")]);

    const [put] = mock.of(SNAPSHOT);
    expect(put.method).toBe("PUT");
    expect(put.authorization).toBe("Bearer cloud-token");
    expect(put.body.source_id).toBe("svc");
    const tools = put.body.tools as Record<string, unknown>[];
    expect(tools.map((t) => t.id)).toEqual(["charge", "refund"]);
    expect(tools[0]).not.toHaveProperty("execute");
  });

  it("skips an unchanged catalog and re-sends after a change", async () => {
    const c = catalog();
    await c.register([tool("refund")]);
    expect((await c.syncNow()).skipped).toBe(true);
    await c.register(tool("charge"));
    expect(mock.of(SNAPSHOT)).toHaveLength(2);
  });

  it("rejects register with a typed error when the sync fails", async () => {
    mock.syncs.push({ status: 401, body: { error: { message: "bad key" } } });
    const c = catalog();
    const error = await c.register(tool("refund")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudError);
    expect((error as CloudError).code).toBe("Unauthorized");
    expect(c.has("refund")).toBe(true);
  });

  it("only warns on a failed sync with onSyncError: warn", async () => {
    mock.syncs.push({ status: 503, body: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = catalog({ onSyncError: "warn" });
    await expect(c.register(tool("refund"))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sync"));
    warn.mockRestore();
  });
});

describe("ToolCatalog cloud: pick", () => {
  it("ranks through the Tool Picker with the catalog's mode", async () => {
    const c = catalog({ mode: "exhaustive" });
    await c.register([tool("a_tool"), tool("b_tool")]);

    const hits = await c.searchAsync("do the thing", 5);

    const [pick] = mock.of(PICK);
    expect(pick.method).toBe("POST");
    expect(pick.body).toEqual({ query: "do the thing", mode: "exhaustive", top_k: 5 });
    expect(hits.map((h) => h.toolId)).toEqual(["b_tool", "a_tool"]);
    expect(hits[0].fused).toBe(false);
  });

  it("defaults to precise, takes a per-call mode, and clamps topK to 20", async () => {
    const c = catalog();
    await c.register(tool("a_tool"));
    await c.searchAsync("q", 50);
    await c.searchAsync("q", 5, { mode: "instant" });
    const picks = mock.of(PICK).map((p) => p.body);
    expect(picks[0]).toMatchObject({ mode: "precise", top_k: 20 });
    expect(picks[1]).toMatchObject({ mode: "instant", top_k: 5 });
  });

  it("drops and warns about picked ids not registered here", async () => {
    const c = catalog();
    await c.register(tool("refund"));
    mock.picks.push({
      status: 200,
      body: {
        tools: [
          { id: "ghost", score: 0.9 },
          { id: "refund", score: 0.5 },
        ],
        confident: true,
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hits = await c.searchAsync("q", 5);
    expect(hits.map((h) => h.toolId)).toEqual(["refund"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ghost"));
    warn.mockRestore();
  });

  it("raises typed errors, with Retry-After on 429", async () => {
    const c = catalog();
    await c.register(tool("refund"));
    mock.picks.push({ status: 409, body: { error: { message: "sync first" } } });
    mock.picks.push({ status: 429, body: {}, headers: { "retry-after": "7" } });

    const noTools = (await c.searchAsync("q", 5).catch((e: unknown) => e)) as CloudError;
    expect(noTools).toBeInstanceOf(CloudError);
    expect(noTools.code).toBe("NoSyncedTools");
    const limited = (await c.searchAsync("q", 5).catch((e: unknown) => e)) as CloudError;
    expect(limited.code).toBe("RateLimited");
    expect(limited.retryAfterSecs).toBe(7);
  });

  it("keeps synchronous search off the network", async () => {
    const c = catalog();
    await c.register(tool("refund"));
    expect(() => c.search("q", 5)).toThrow(/searchAsync/);
  });

  it("rejects cloud together with a local method or reranker", () => {
    const cloud = { url: mock.url, apiKeyEnv: KEY_ENV };
    expect(() => new ToolCatalog({ cloud, method: "semantic" })).toThrow(/cloud/);
    expect(() => new ToolCatalog({ cloud, reranker: { method: "semantic" } })).toThrow(/cloud/);
    expect(() => new ToolCatalog({ cloud: { ...cloud, mode: "fast" as never } })).toThrow(/mode/);
  });
});

describe("ratel() cloud", () => {
  it("syncs under the runtime's sourceId and picks for tools", async () => {
    const r = ratel({
      cloud: { url: mock.url, apiKeyEnv: KEY_ENV, mode: "instant" },
      events: { sourceId: "checkout-api" },
    });
    await r.tools.register(tool("refund"), tool("charge"));
    expect(mock.of(SNAPSHOT)[0].body.source_id).toBe("checkout-api");

    const hits = await r.tools.searchAsync("money back", 5);
    expect(hits.map((h) => h.toolId)).toEqual(["refund", "charge"]);
    expect(mock.of(PICK)[0].body).toMatchObject({ mode: "instant" });
  });
});
