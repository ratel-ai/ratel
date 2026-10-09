import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetOpenAIDecisionWarningForTest } from "./experimental-warning.js";
import {
  type ExecutableTool,
  RetrieverError,
  ratelOpenAIDecisionPlugin,
  SkillCatalog,
  ToolCatalog,
} from "./index.js";

const KEY_ENV = "RATEL_SDK_TS_OPENAI_DECISION_TEST_KEY";

interface Question {
  type: string;
  name: string;
  instructions: string;
  choices: { value: string; description: string }[];
}

interface SeenRequest {
  path: string;
  authorization: string | undefined;
  body: { model: string; input: string; questions: Question[] };
}

/** A stand-in for OpenAI's `POST /v1/decisions`: answers each request with the
 * next scripted reply, or — when none is queued — with probabilities that rank
 * the choices in reverse (`tN` highest), and records what it was sent. */
class MockDecisions {
  readonly seen: SeenRequest[] = [];
  private preferred: { id: string; p: number } | undefined;
  private readonly replies: { status: number; body: unknown; headers?: Record<string, string> }[] =
    [];
  private server!: Server;
  url = "";

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const body = JSON.parse(await readBody(req)) as SeenRequest["body"];
      this.seen.push({ path: req.url ?? "", authorization: req.headers.authorization, body });
      const [question] = body.questions;
      const preferred = this.preferred;
      const probabilities = question.choices.map((c, i) => {
        if (!preferred)
          return { value: c.value, probability: (i + 1) / (question.choices.length + 1) };
        const id = c.description.split(" ")[0];
        return { value: c.value, probability: id === preferred.id ? preferred.p : 0 };
      });
      const reply = this.replies.shift() ?? {
        status: 200,
        body: {
          answers: [{ type: "choice", name: question.name, probabilities, confidence: 0.9 }],
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

  /** The candidate ids the `call`-th question offered, in choice order. */
  offered(call = 0): string[] {
    return this.seen[call].body.questions[0].choices.map((c) => c.description.split(" ")[0]);
  }

  /** Answer with `p` for `id` and 0 for every other choice. */
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

const mock = new MockDecisions();

beforeAll(async () => {
  process.env[KEY_ENV] = "sk-test";
  process.env.RATEL_EXPERIMENTAL_SILENCE = "1";
  await mock.start();
});

afterAll(async () => {
  delete process.env.RATEL_EXPERIMENTAL_SILENCE;
  await mock.stop();
});

const decision = () => ratelOpenAIDecisionPlugin({ url: mock.url, apiKeyEnv: KEY_ENV });

async function bm25Order(query: string, topK: number): Promise<string[]> {
  const plain = new ToolCatalog();
  await plain.register(TOOLS);
  return plain.search(query, topK).map((h) => h.toolId);
}

describe("ratelOpenAIDecisionPlugin", () => {
  it("as retrieveFn asks one tool choice question over every tool and ranks by probability", async () => {
    mock.reset();
    mock.prefer("send_email", 0.93);
    const catalog = new ToolCatalog({ method: "custom", retrieveFn: decision().retrieve });
    await catalog.register(TOOLS);

    const hits = await catalog.searchAsync("tell my boss I'm late", 1);

    expect(hits.map((h) => [h.toolId, h.score])).toEqual([["send_email", expect.closeTo(0.93)]]);
    expect(mock.seen).toHaveLength(1);
    const [request] = mock.seen;
    expect(request.path).toBe("/v1/decisions");
    expect(request.authorization).toBe("Bearer sk-test");
    expect(request.body.model).toBe("gpt-6-luna");
    expect(request.body.input).toBe("tell my boss I'm late");
    expect(request.body.questions.map((q) => [q.type, q.name])).toEqual([["choice", "tool"]]);
    expect(mock.offered().sort()).toEqual(TOOLS.map((t) => t.id).sort());
  });

  it("as rerankerFn sees only stage 1's candidates", async () => {
    mock.reset();
    const query = "read a file from disk";
    const stageOne = await bm25Order(query, 50);
    mock.prefer(stageOne[stageOne.length - 1], 0.9);
    const catalog = new ToolCatalog({ rerankerFn: decision().rerank, rerankerDepth: 20 });
    await catalog.register(TOOLS);

    const hits = await catalog.searchAsync(query, 2);

    expect(hits[0].toolId).toBe(stageOne[stageOne.length - 1]);
    expect(mock.offered()).toEqual(stageOne);
  });

  it("asks a skill question for skills", async () => {
    mock.reset();
    mock.prefer("api_design", 0.8);
    const skills = new SkillCatalog({ method: "custom", retrieveFn: decision().retrieve });
    await skills.register([
      { id: "api_design", name: "api_design", description: "design rest endpoints", body: "b" },
      { id: "deploy", name: "deploy", description: "deploy a service", body: "b" },
    ]);
    const hits = await skills.searchAsync("design an api", 1);
    expect(hits[0].skillId).toBe("api_design");
    expect(mock.seen[0].body.questions[0].name).toBe("skill");
  });

  it("throws a non-transient RetrieverError for a rejected key, even as a reranker", async () => {
    mock.reset();
    mock.reply(401, { error: { message: "bad key" } });
    const catalog = new ToolCatalog({ rerankerFn: decision().rerank });
    await catalog.register(TOOLS);
    const error = await catalog.searchAsync("file", 2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetrieverError);
    expect(error).toMatchObject({ code: "Unauthorized", status: 401, transient: false });
    expect((error as Error).message).toContain("openai decisions");
  });

  it("falls back to stage 1 on a refusal, and throws Refused as the first stage", async () => {
    mock.reset();
    const refusal = { answers: [{ type: "refusal", name: "tool" }] };
    mock.reply(200, refusal);
    const reranked = new ToolCatalog({ rerankerFn: decision().rerank });
    await reranked.register(TOOLS);
    const hits = await reranked.searchAsync("delete a file", 3);
    expect(hits.map((h) => h.toolId)).toEqual(await bm25Order("delete a file", 3));

    mock.reply(200, refusal);
    const custom = new ToolCatalog({ method: "custom", retrieveFn: decision().retrieve });
    await custom.register(TOOLS);
    await expect(custom.searchAsync("delete a file", 3)).rejects.toMatchObject({
      code: "Refused",
      transient: true,
    });
  });

  it("falls back to stage 1 when OpenAI is overloaded", async () => {
    mock.reset();
    mock.reply(503, { error: { message: "busy" } });
    const reranked = new ToolCatalog({ rerankerFn: decision().rerank });
    await reranked.register(TOOLS);
    const hits = await reranked.searchAsync("delete a file", 3);
    expect(hits.map((h) => h.toolId)).toEqual(await bm25Order("delete a file", 3));
  });

  it("carries Retry-After on a rate limit", async () => {
    mock.reset();
    mock.reply(429, {}, { "retry-after": "7" });
    const catalog = new ToolCatalog({ method: "custom", retrieveFn: decision().retrieve });
    await catalog.register(TOOLS);
    await expect(catalog.searchAsync("q", 2)).rejects.toMatchObject({
      code: "RateLimited",
      retryAfterSecs: 7,
      transient: true,
    });
  });

  it("fails before any request when the key env var is unset", async () => {
    mock.reset();
    const plugin = ratelOpenAIDecisionPlugin({
      url: mock.url,
      apiKeyEnv: "RATEL_SDK_TS_OPENAI_DECISION_UNSET_KEY",
    });
    const catalog = new ToolCatalog({ method: "custom", retrieveFn: plugin.retrieve });
    await catalog.register(TOOLS);
    await expect(catalog.searchAsync("q", 2)).rejects.toMatchObject({
      code: "Config",
      transient: false,
    });
    expect(mock.seen).toHaveLength(0);
  });
});

describe("the OpenAI Decisions beta warning", () => {
  it("prints once, when the first plugin is made", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const silence = process.env.RATEL_EXPERIMENTAL_SILENCE;
    delete process.env.RATEL_EXPERIMENTAL_SILENCE;
    try {
      resetOpenAIDecisionWarningForTest();
      ratelOpenAIDecisionPlugin();
      ratelOpenAIDecisionPlugin();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain("beta");
      expect(message).toContain("gpt-6-luna");
      expect(message).toContain("sent to OpenAI");
      expect(message).toContain("RATEL_EXPERIMENTAL_SILENCE");
    } finally {
      process.env.RATEL_EXPERIMENTAL_SILENCE = silence;
      warn.mockRestore();
    }
  });

  it("names an overridden model", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const silence = process.env.RATEL_EXPERIMENTAL_SILENCE;
    delete process.env.RATEL_EXPERIMENTAL_SILENCE;
    try {
      resetOpenAIDecisionWarningForTest();
      ratelOpenAIDecisionPlugin({ model: "gpt-6-luna-preview" });
      expect(String(warn.mock.calls[0][0])).toContain("gpt-6-luna-preview");
    } finally {
      process.env.RATEL_EXPERIMENTAL_SILENCE = silence;
      warn.mockRestore();
    }
  });

  it("stays quiet with RATEL_EXPERIMENTAL_SILENCE set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      resetOpenAIDecisionWarningForTest();
      ratelOpenAIDecisionPlugin();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
