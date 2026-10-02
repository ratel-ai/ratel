import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ExecutableTool, SkillCatalog, SystemOneError, ToolCatalog } from "./index.js";

const KEY_ENV = "RATEL_SDK_TS_SYSTEM_ONE_TEST_KEY";

interface SeenRequest {
  path: string;
  authorization: string | undefined;
  body: {
    model: string;
    state: string;
    questions: Record<
      string,
      { type: string; instructions: string; criteria: Record<string, string> }
    >;
  };
}

/** A stand-in for Jev's `POST /v1/systemone`: answers each request with the
 * next scripted reply, or — when none is queued — with probabilities that rank
 * the options in reverse (`tN` highest), and records what it was sent. */
class MockSystemOne {
  readonly seen: SeenRequest[] = [];
  private preferred: { id: string; p: number } | undefined;
  private readonly replies: { status: number; body: unknown; headers?: Record<string, string> }[] =
    [];
  private server!: Server;
  url = "";

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const body = JSON.parse(await readBody(req));
      this.seen.push({ path: req.url ?? "", authorization: req.headers.authorization, body });
      const scripted = this.replies.shift();
      // The question id is the kind being ranked: "tool", "skill", ….
      const [kind, question] = Object.entries(body.questions)[0] as [
        string,
        { criteria: Record<string, string> },
      ];
      const keys = Object.keys(question.criteria);
      const preferred = this.preferred;
      const reply = scripted ?? {
        status: 200,
        body: {
          model: "jev-1.13.0",
          answers: {
            [kind]: {
              type: "choice",
              probabilities: Object.fromEntries(
                keys.map((k, i) => {
                  if (!preferred) return [k, (i + 1) / (keys.length + 1)];
                  const id = question.criteria[k].split(" ")[0];
                  return [k, id === preferred.id ? preferred.p : 0];
                }),
              ),
            },
          },
        },
      };
      res.writeHead(reply.status, {
        "content-type": "application/json",
        ...("headers" in reply ? reply.headers : {}),
      });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
  }

  /** The candidate ids the `call`-th question offered, in option order. A
   * candidate's searchable text starts with its full name, and these fixtures
   * name every item after its id. */
  offered(call = 0): string[] {
    const [question] = Object.values(this.seen[call].body.questions);
    return Object.values(question.criteria).map((t) => t.split(" ")[0]);
  }

  /** Answer with `p` for `id` and 0 for every other option. */
  prefer(id: string, p: number): void {
    this.preferred = { id, p };
  }

  reply(status: number, body: unknown = {}, headers?: Record<string, string>): void {
    this.replies.push({ status, body, headers });
  }

  reset(): void {
    this.preferred = undefined;
    this.seen.length = 0;
    this.replies.length = 0;
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
    req.on("end", () => resolve(data));
  });
}

function tool(id: string, description: string): ExecutableTool {
  return {
    id,
    name: id,
    description,
    inputSchema: {},
    outputSchema: {},
    execute: async () => "ok",
  };
}

const TOOLS = [
  tool("read_file", "read a file from disk"),
  tool("delete_file", "delete a file from disk"),
  tool("list_files", "list the files in a directory"),
  tool("send_email", "send an email message"),
];

const mock = new MockSystemOne();

beforeAll(async () => {
  process.env[KEY_ENV] = "s1-token";
  await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

/** BM25 order for `query` from a catalog with no reranker — stage 1's view. */
async function bm25Order(query: string, topK: number): Promise<string[]> {
  const plain = new ToolCatalog();
  await plain.register(TOOLS);
  return plain.search(query, topK).map((h) => h.toolId);
}

function catalog(options: ConstructorParameters<typeof ToolCatalog>[0] = {}): ToolCatalog {
  return new ToolCatalog({ systemOne: { url: mock.url, apiKeyEnv: KEY_ENV }, ...options });
}

describe("ToolCatalog systemOne", () => {
  it("ranks the whole catalog with method systemOne", async () => {
    mock.reset();
    mock.prefer("send_email", 0.8);
    const c = catalog({ method: "systemOne" });
    await c.register(TOOLS);

    const hits = await c.searchAsync("email my boss", 5);

    expect(hits[0].toolId).toBe("send_email");
    expect(hits[0].score).toBeCloseTo(0.8);
    expect(hits.slice(1).every((h) => h.score === 0)).toBe(true);
    expect(hits[0].fused).toBe(false);
    expect(mock.seen).toHaveLength(1);
    expect(mock.seen[0].authorization).toBe("Bearer s1-token");
    expect(mock.seen[0].path).toBe("/v1/systemone");
    expect(mock.seen[0].body.state).toBe("email my boss");
    expect(mock.seen[0].body.model).toBe("jev-latest");
    expect(mock.seen[0].body.questions.tool.type).toBe("choice");
    expect(mock.seen[0].body.questions.tool.instructions).toContain("tool");
    expect(mock.offered().sort()).toEqual(TOOLS.map((t) => t.id).sort());
  });

  it("raises a typed SystemOneError when standalone ranking fails", async () => {
    mock.reset();
    mock.reply(429);
    const c = catalog({ method: "systemOne" });
    await c.register(TOOLS);

    const error = await c.searchAsync("email my boss", 5).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SystemOneError);
    expect((error as SystemOneError).code).toBe("RateLimited");
  });

  it("reranks only the first stage's candidates", async () => {
    mock.reset();
    const c = catalog({ reranker: { method: "systemOne", depth: 10 } });
    await c.register(TOOLS);
    const stageOne = await bm25Order("file", 10);

    const hits = await c.searchAsync("file", 10);

    const offered = mock.offered();
    expect(offered).toEqual(stageOne);
    expect(offered).not.toContain("send_email");
    // The mock ranks in reverse, so the reranked order is stage one reversed.
    expect(hits.map((h) => h.toolId)).toEqual([...offered].reverse());
  });

  it("falls back to the first stage when the reranker fails", async () => {
    mock.reset();
    mock.reply(503);
    const c = catalog({ reranker: { method: "systemOne" } });
    await c.register(TOOLS);
    const hits = await c.searchAsync("file", 3);

    expect(hits.map((h) => h.toolId)).toEqual(await bm25Order("file", 3));
  });

  it("throws instead of falling back when the reranker is misconfigured", async () => {
    mock.reset();
    mock.reply(401, { error: { message: "bad key" } });
    const c = catalog({ reranker: { method: "systemOne" } });
    await c.register(TOOLS);

    const error = await c.searchAsync("file", 3).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SystemOneError);
    expect((error as SystemOneError).code).toBe("Unauthorized");
    expect((error as SystemOneError).status).toBe(401);
  });

  it("falls back on a rate limit and reports Retry-After when standalone", async () => {
    mock.reset();
    mock.reply(429, {}, { "retry-after": "7" });
    const reranked = catalog({ reranker: { method: "systemOne" } });
    await reranked.register(TOOLS);
    expect((await reranked.searchAsync("file", 3)).map((h) => h.toolId)).toEqual(
      await bm25Order("file", 3),
    );

    mock.reply(429, {}, { "retry-after": "7" });
    const standalone = catalog({ method: "systemOne" });
    await standalone.register(TOOLS);
    const error = (await standalone.searchAsync("q", 3).catch((e: unknown) => e)) as SystemOneError;
    expect(error.code).toBe("RateLimited");
    expect(error.retryAfterSecs).toBe(7);
  });

  it("takes per-call options, including turning the reranker off", async () => {
    mock.reset();
    const c = catalog({ reranker: { method: "systemOne" } });
    await c.register(TOOLS);

    const plain = await c.searchAsync("file", 3, { reranker: null });
    expect(mock.seen).toHaveLength(0);
    expect(plain.map((h) => h.toolId)).toEqual(await bm25Order("file", 3));

    await c.searchAsync("file", 3, { origin: "agent", method: "systemOne", reranker: null });
    expect(mock.seen).toHaveLength(1);
  });

  it("rejects a reranker that repeats the first-stage method", () => {
    expect(() => catalog({ method: "bm25", reranker: { method: "bm25" } })).toThrow(/same/);
  });

  it("rejects a non-positive reranker depth", () => {
    expect(() => catalog({ reranker: { method: "systemOne", depth: 0 } })).toThrow(/depth/);
  });

  it("keeps synchronous search off the network", async () => {
    const standalone = catalog({ method: "systemOne" });
    await standalone.register(TOOLS);
    expect(() => standalone.search("file", 3)).toThrow(/asynchronous/);

    const reranked = catalog({ reranker: { method: "systemOne" } });
    await reranked.register(TOOLS);
    expect(() => reranked.search("file", 3)).toThrow(/searchAsync/);
  });
});

describe("SkillCatalog systemOne", () => {
  it("reranks skills the same way", async () => {
    mock.reset();
    const skills = new SkillCatalog({
      reranker: { method: "systemOne" },
      systemOne: { url: mock.url, apiKeyEnv: KEY_ENV },
    });
    await skills.register([
      { id: "pdf_forms", name: "pdf_forms", description: "fill pdf forms", body: "b" },
      { id: "pdf_merge", name: "pdf_merge", description: "merge pdf files", body: "b" },
      { id: "slides", name: "slides", description: "build slide decks", body: "b" },
    ]);

    const hits = await skills.searchAsync("pdf", 5);

    const offered = mock.offered();
    expect(offered).not.toContain("slides");
    expect(hits.map((h) => h.skillId)).toEqual([...offered].reverse());
  });
});
