import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ExecutableTool,
  RetrieverError,
  ratelJevPlugin,
  SkillCatalog,
  ToolCatalog,
} from "./index.js";

const KEY_ENV = "RATEL_SDK_TS_JEV_TEST_KEY";

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
class MockJev {
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

const mock = new MockJev();

beforeAll(async () => {
  process.env[KEY_ENV] = "jev-token";
  await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

const jev = () => ratelJevPlugin({ url: mock.url, apiKeyEnv: KEY_ENV });

async function bm25Order(query: string, topK: number): Promise<string[]> {
  const plain = new ToolCatalog();
  await plain.register(TOOLS);
  return plain.search(query, topK).map((h) => h.toolId);
}

describe("ratelJevPlugin", () => {
  it("as retrieveFn asks Jev one tool question over every tool and ranks by probability", async () => {
    mock.reset();
    mock.prefer("send_email", 0.93);
    const catalog = new ToolCatalog({ method: "custom", retrieveFn: jev().retrieve });
    await catalog.register(TOOLS);

    const hits = await catalog.searchAsync("tell my boss I'm late", 1);

    expect(hits.map((h) => [h.toolId, h.score])).toEqual([["send_email", expect.closeTo(0.93)]]);
    expect(mock.seen).toHaveLength(1);
    const [request] = mock.seen;
    expect(request.path).toBe("/v1/systemone");
    expect(request.authorization).toBe("Bearer jev-token");
    expect(request.body.model).toBe("jev-latest");
    expect(Object.keys(request.body.questions)).toEqual(["tool"]);
    expect(mock.offered().sort()).toEqual(TOOLS.map((t) => t.id).sort());
  });

  it("as rerankerFn sees only stage 1's candidates", async () => {
    mock.reset();
    const query = "read a file from disk";
    const stageOne = await bm25Order(query, 50);
    mock.prefer(stageOne[stageOne.length - 1], 0.9);
    const catalog = new ToolCatalog({ rerankerFn: jev().rerank });
    await catalog.register(TOOLS);

    const hits = await catalog.searchAsync(query, 2);

    expect(hits[0].toolId).toBe(stageOne[stageOne.length - 1]);
    expect(mock.offered()).toEqual(stageOne);
  });

  it("asks a skill question for skills", async () => {
    mock.reset();
    mock.prefer("api_design", 0.8);
    const skills = new SkillCatalog({ method: "custom", retrieveFn: jev().retrieve });
    await skills.register([
      { id: "api_design", name: "api_design", description: "design rest endpoints", body: "b" },
      { id: "deploy", name: "deploy", description: "deploy a service", body: "b" },
    ]);
    const hits = await skills.searchAsync("design an api", 1);
    expect(hits[0].skillId).toBe("api_design");
    expect(Object.keys(mock.seen[0].body.questions)).toEqual(["skill"]);
  });

  it("throws a non-transient RetrieverError for a rejected key, even as a reranker", async () => {
    mock.reset();
    mock.reply(401, { error: { message: "bad key" } });
    const catalog = new ToolCatalog({ rerankerFn: jev().rerank });
    await catalog.register(TOOLS);
    const error = await catalog.searchAsync("file", 2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetrieverError);
    expect(error).toMatchObject({ code: "Unauthorized", status: 401, transient: false });
  });

  it("falls back to stage 1 when Jev is overloaded, and throws as the first stage", async () => {
    mock.reset();
    mock.reply(503, { error: { message: "busy" } });
    const reranked = new ToolCatalog({ rerankerFn: jev().rerank });
    await reranked.register(TOOLS);
    const hits = await reranked.searchAsync("delete a file", 3);
    expect(hits.map((h) => h.toolId)).toEqual(await bm25Order("delete a file", 3));

    mock.reply(503, { error: { message: "busy" } });
    const custom = new ToolCatalog({ method: "custom", retrieveFn: jev().retrieve });
    await custom.register(TOOLS);
    await expect(custom.searchAsync("delete a file", 3)).rejects.toMatchObject({
      code: "Overloaded",
      transient: true,
    });
  });

  it("carries Retry-After on a rate limit", async () => {
    mock.reset();
    mock.reply(429, {}, { "retry-after": "7" });
    const catalog = new ToolCatalog({ method: "custom", retrieveFn: jev().retrieve });
    await catalog.register(TOOLS);
    await expect(catalog.searchAsync("q", 2)).rejects.toMatchObject({
      code: "RateLimited",
      retryAfterSecs: 7,
      transient: true,
    });
  });

  it("fails before any request when the key env var is unset", async () => {
    mock.reset();
    const plugin = ratelJevPlugin({ url: mock.url, apiKeyEnv: "RATEL_SDK_TS_JEV_UNSET_KEY" });
    const catalog = new ToolCatalog({ method: "custom", retrieveFn: plugin.retrieve });
    await catalog.register(TOOLS);
    await expect(catalog.searchAsync("q", 2)).rejects.toMatchObject({
      code: "Config",
      transient: false,
    });
    expect(mock.seen).toHaveLength(0);
  });
});
