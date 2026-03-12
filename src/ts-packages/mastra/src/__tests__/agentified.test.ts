import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateTool = vi.fn(({ id, execute }: any) => ({
  id,
  execute,
  __mastraTool: true,
}));

vi.mock("@mastra/core/tools", () => ({
  createTool: (...args: any[]) => mockCreateTool(...args),
}));

import { mastra, MastraAgentified, MastraInstance, MastraSession, MastraNamespace, MastraDatasetRef, MastraContextBuilder, MastraAssembledContext } from "../agentified.js";
import type { Agentified, Instance, Session, Namespace, DatasetRef, ContextBuilder } from "agentified";

describe("mastra() adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns object with adapt method", () => {
    const adapter = mastra();
    expect(adapter).toHaveProperty("adapt");
    expect(typeof adapter.adapt).toBe("function");
  });

  it("adapt wraps Agentified into MastraAgentified", () => {
    const fakeAg = {} as Agentified;
    const result = mastra().adapt(fakeAg);
    expect(result).toBeInstanceOf(MastraAgentified);
  });
});

describe("MastraAgentified", () => {
  function fakeAgentified() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      dataset: vi.fn(),
      register: vi.fn(),
    } as unknown as Agentified;
  }

  it("delegates connect()", async () => {
    const ag = fakeAgentified();
    const m = new MastraAgentified(ag);
    await m.connect("http://localhost:9119");
    expect(ag.connect).toHaveBeenCalledWith("http://localhost:9119");
  });

  it("delegates disconnect()", async () => {
    const ag = fakeAgentified();
    const m = new MastraAgentified(ag);
    await m.disconnect();
    expect(ag.disconnect).toHaveBeenCalled();
  });

  it("dataset() returns MastraDatasetRef", () => {
    const ag = fakeAgentified();
    const fakeRef = {} as DatasetRef;
    (ag.dataset as ReturnType<typeof vi.fn>).mockReturnValue(fakeRef);

    const m = new MastraAgentified(ag);
    const ref = m.dataset("test");
    expect(ref).toBeInstanceOf(MastraDatasetRef);
    expect(ag.dataset).toHaveBeenCalledWith("test");
  });

  it("register() returns MastraInstance", async () => {
    const ag = fakeAgentified();
    const fakeInstance = {
      instanceId: "default",
      datasetId: "default",
      discoverTool: {
        definition: { name: "agentified_discover", description: "Find tools", parameters: {} },
        execute: vi.fn(),
      },
      prepareStep: vi.fn(),
      session: vi.fn(),
      namespace: vi.fn(),
    } as unknown as Instance;
    (ag.register as ReturnType<typeof vi.fn>).mockResolvedValue(fakeInstance);

    const m = new MastraAgentified(ag);
    const inst = await m.register({ tools: [] });
    expect(inst).toBeInstanceOf(MastraInstance);
  });
});

describe("MastraInstance", () => {
  function fakeInstance() {
    return {
      instanceId: "my-dataset",
      datasetId: "my-dataset",
      discoverTool: {
        definition: { name: "agentified_discover", description: "Find tools", parameters: {} },
        execute: vi.fn().mockResolvedValue([{ name: "tool1", score: 0.9 }]),
        discoveredNames: new Set<string>(),
      },
      prepareStep: vi.fn().mockResolvedValue({ activeTools: ["t1"] }),
      session: vi.fn(),
      namespace: vi.fn(),
    } as unknown as Instance;
  }

  it("wraps discoverTool with createTool", () => {
    const inst = fakeInstance();
    const m = new MastraInstance(inst, []);

    expect(m.discoverTool.__mastraTool).toBe(true);
    expect(mockCreateTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agentified_discover" }),
    );
  });

  it("prepareStep is a property that includes discover tool", async () => {
    const inst = fakeInstance();
    const m = new MastraInstance(inst, []);

    expect(typeof m.prepareStep).toBe("function");

    const result = await m.prepareStep({ stepNumber: 0, steps: [] });
    expect(result.tools).toBeDefined();
    expect(result.tools["agentified_discover"]).toBe(m.discoverTool);
  });

  it("prepareStep delegates to SDK instance prepareStep", async () => {
    const inst = fakeInstance();
    const m = new MastraInstance(inst, []);
    await m.prepareStep({ stepNumber: 1, steps: [{ text: "hi" }] });
    expect(inst.prepareStep).toHaveBeenCalledWith({ stepNumber: 1, steps: [{ text: "hi" }] });
  });

  it("prepareStep merges discovered backend tools", async () => {
    const backendTools = [{
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: {} },
      handler: vi.fn(),
    }];
    const inst = fakeInstance();
    inst.discoverTool.discoveredNames.add("get_weather");

    const m = new MastraInstance(inst, backendTools);
    const result = await m.prepareStep({ stepNumber: 0, steps: [] });

    expect(result.tools["agentified_discover"]).toBe(m.discoverTool);
    expect(result.tools["get_weather"]).toBeDefined();
    expect(result.tools["get_weather"].id).toBe("get_weather");
  });

  it("does not expose a tools property", () => {
    const inst = fakeInstance();
    const m = new MastraInstance(inst, []);
    expect((m as any).tools).toBeUndefined();
  });

  it("exposes instanceId and datasetId", () => {
    const inst = fakeInstance();
    const m = new MastraInstance(inst, []);
    expect(m.instanceId).toBe("my-dataset");
    expect(m.datasetId).toBe("my-dataset");
  });

  it("session() returns MastraSession", () => {
    const inst = fakeInstance();
    const fakeSession = {
      id: "chat-1",
      namespaceId: "default",
      discoverTool: {
        definition: { name: "agentified_discover", description: "Find tools", parameters: {} },
        execute: vi.fn(),
      },
      prepareStep: vi.fn(),
      context: {},
      conversation: {},
      getMessages: vi.fn(),
      updateConversation: vi.fn(),
    } as unknown as Session;
    (inst.session as ReturnType<typeof vi.fn>).mockReturnValue(fakeSession);

    const m = new MastraInstance(inst, []);
    const session = m.session("chat-1");
    expect(session).toBeInstanceOf(MastraSession);
    expect(inst.session).toHaveBeenCalledWith("chat-1");
  });

  it("namespace() returns MastraNamespace", () => {
    const inst = fakeInstance();
    const fakeNs = { id: "user-1", session: vi.fn() } as unknown as Namespace;
    (inst.namespace as ReturnType<typeof vi.fn>).mockReturnValue(fakeNs);

    const m = new MastraInstance(inst, []);
    const ns = m.namespace("user-1");
    expect(ns).toBeInstanceOf(MastraNamespace);
    expect(inst.namespace).toHaveBeenCalledWith("user-1");
  });
});

describe("MastraSession", () => {
  function fakeSession() {
    return {
      id: "chat-1",
      namespaceId: "default",
      discoverTool: {
        definition: { name: "agentified_discover", description: "Find tools", parameters: {} },
        execute: vi.fn(),
        discoveredNames: new Set<string>(),
      },
      prepareStep: vi.fn(),
      context: { messages: vi.fn().mockReturnThis(), recall: vi.fn().mockReturnThis(), assemble: vi.fn() },
      conversation: { append: vi.fn() },
      getMessages: vi.fn(),
      updateConversation: vi.fn(),
    } as unknown as Session;
  }

  it("wraps discoverTool with createTool", () => {
    const sess = fakeSession();
    const m = new MastraSession(sess, []);
    expect(m.discoverTool.__mastraTool).toBe(true);
  });

  it("prepareStep is a property that delegates to SDK session", async () => {
    const sess = fakeSession();
    const m = new MastraSession(sess, []);
    expect(typeof m.prepareStep).toBe("function");
    await m.prepareStep({ stepNumber: 0, steps: [] });
    expect(sess.prepareStep).toHaveBeenCalledWith({ stepNumber: 0, steps: [] });
  });

  it("prepareStep merges discovered backend tools", async () => {
    const backendTools = [{
      name: "search_docs",
      description: "Search docs",
      parameters: { type: "object", properties: {} },
      handler: vi.fn(),
    }];
    const sess = fakeSession();
    sess.discoverTool.discoveredNames.add("search_docs");

    const m = new MastraSession(sess, backendTools);
    const result = await m.prepareStep({ stepNumber: 0, steps: [] });

    expect(result.tools["agentified_discover"]).toBe(m.discoverTool);
    expect(result.tools["search_docs"]).toBeDefined();
    expect(result.tools["search_docs"].id).toBe("search_docs");
  });

  it("exposes id, conversation", () => {
    const sess = fakeSession();
    const m = new MastraSession(sess, []);
    expect(m.id).toBe("chat-1");
    expect(m.conversation).toBe(sess.conversation);
  });

  it("delegates getMessages", async () => {
    const sess = fakeSession();
    const m = new MastraSession(sess, []);
    await m.getMessages({ strategy: "recent" });
    expect(sess.getMessages).toHaveBeenCalledWith({ strategy: "recent" });
  });

  it("delegates updateConversation", async () => {
    const sess = fakeSession();
    const m = new MastraSession(sess, []);
    const input = { messages: [{ role: "user", content: "hi" }] };
    await m.updateConversation(input);
    expect(sess.updateConversation).toHaveBeenCalledWith(input);
  });
});

describe("MastraNamespace", () => {
  it("exposes id and returns MastraSession from session()", () => {
    const fakeSession = {
      id: "chat-1",
      discoverTool: {
        definition: { name: "agentified_discover", description: "d", parameters: {} },
        execute: vi.fn(),
      },
      prepareStep: vi.fn(),
      context: {},
      conversation: {},
      getMessages: vi.fn(),
      updateConversation: vi.fn(),
    } as unknown as Session;
    const fakeNs = {
      id: "user-1",
      session: vi.fn().mockReturnValue(fakeSession),
    } as unknown as Namespace;

    const m = new MastraNamespace(fakeNs, []);
    expect(m.id).toBe("user-1");
    const session = m.session("chat-1");
    expect(session).toBeInstanceOf(MastraSession);
  });
});

describe("MastraContextBuilder", () => {
  function fakeContextBuilder() {
    return {
      tools: vi.fn().mockReturnThis(),
      messages: vi.fn().mockReturnThis(),
      recall: vi.fn().mockReturnThis(),
      assemble: vi.fn().mockResolvedValue({
        messages: [], recalled: { tools: [], memories: [] },
        strategyUsed: "recent", fallback: false,
        tokenEstimate: 0, conversationMessages: 0,
        totalMessages: 0, includedMessages: 0,
        tools: {},
      }),
    } as unknown as ContextBuilder;
  }

  it("tools() is chainable", () => {
    const sdkBuilder = fakeContextBuilder();
    const discoverTool = { id: "agentified_discover", __mastraTool: true } as any;
    const builder = new MastraContextBuilder(
      sdkBuilder, vi.fn(), discoverTool, new Set(), {},
    );
    const result = builder.tools({ my_tool: discoverTool });
    expect(result).toBe(builder);
  });

  it("messages() delegates to SDK builder", () => {
    const sdkBuilder = fakeContextBuilder();
    const builder = new MastraContextBuilder(
      sdkBuilder, vi.fn(), { id: "agentified_discover" } as any, new Set(), {},
    );
    builder.messages({ strategy: "recent" });
    expect(sdkBuilder.messages).toHaveBeenCalledWith({ strategy: "recent" });
  });

  it("recall() delegates to SDK builder", () => {
    const sdkBuilder = fakeContextBuilder();
    const builder = new MastraContextBuilder(
      sdkBuilder, vi.fn(), { id: "agentified_discover" } as any, new Set(), {},
    );
    builder.recall();
    expect(sdkBuilder.recall).toHaveBeenCalled();
  });

  it("assemble() returns MastraAssembledContext with explicit + discovered tools", async () => {
    const sdkBuilder = fakeContextBuilder();
    const myTool = { id: "my_tool", __mastraTool: true } as any;
    const cachedTool = { id: "cached_tool", __mastraTool: true } as any;
    const discoverTool = { id: "agentified_discover", __mastraTool: true } as any;
    const discoveredNames = new Set(["cached_tool"]);
    const mastraToolCache = { cached_tool: cachedTool };

    const builder = new MastraContextBuilder(
      sdkBuilder, vi.fn(), discoverTool, discoveredNames, mastraToolCache,
    );
    builder.tools({ my_tool: myTool });

    const ctx = await builder.assemble();
    expect(ctx).toBeInstanceOf(MastraAssembledContext);
    expect(ctx.tools["my_tool"]).toBe(myTool);
    expect(ctx.tools["cached_tool"]).toBe(cachedTool);
  });
});

describe("MastraAssembledContext", () => {
  it("exposes all AssembledContext fields", () => {
    const sdkCtx = {
      messages: [{ id: "m1", role: "user", content: "hi", seq: 1, createdAt: "" }],
      recalled: { tools: [], memories: [] },
      strategyUsed: "recent" as const,
      fallback: false,
      tokenEstimate: 42,
      conversationMessages: 5,
      totalMessages: 10,
      includedMessages: 3,
      tools: {},
    };
    const ctx = new MastraAssembledContext(sdkCtx, {}, vi.fn());
    expect(ctx.messages).toBe(sdkCtx.messages);
    expect(ctx.recalled).toBe(sdkCtx.recalled);
    expect(ctx.strategyUsed).toBe("recent");
    expect(ctx.fallback).toBe(false);
    expect(ctx.tokenEstimate).toBe(42);
  });

  it("prepareStep delegates to SDK and returns { tools }", async () => {
    const sdkPrepareStep = vi.fn().mockResolvedValue({ activeTools: ["agentified_discover", "tool1"] });
    const tools = { agentified_discover: { id: "d" } as any, tool1: { id: "t1" } as any };
    const sdkCtx = {
      messages: [], recalled: { tools: [], memories: [] },
      strategyUsed: "recent" as const, fallback: false,
      tokenEstimate: 0, conversationMessages: 0,
      totalMessages: 0, includedMessages: 0, tools: {},
    };
    const ctx = new MastraAssembledContext(sdkCtx, tools, sdkPrepareStep);
    const result = await ctx.prepareStep({ stepNumber: 1, steps: [] });
    expect(sdkPrepareStep).toHaveBeenCalledWith({ stepNumber: 1, steps: [] });
    expect(result.tools).toBe(tools);
  });
});

describe("MastraSession.context", () => {
  function fakeSession() {
    return {
      id: "chat-1",
      namespaceId: "default",
      discoverTool: {
        definition: { name: "agentified_discover", description: "Find tools", parameters: {} },
        execute: vi.fn(),
        discoveredNames: new Set<string>(),
      },
      prepareStep: vi.fn(),
      context: {
        tools: vi.fn().mockReturnThis(),
        messages: vi.fn().mockReturnThis(),
        recall: vi.fn().mockReturnThis(),
        assemble: vi.fn().mockResolvedValue({
          messages: [], recalled: { tools: [], memories: [] },
          strategyUsed: "recent", fallback: false,
          tokenEstimate: 0, conversationMessages: 0,
          totalMessages: 0, includedMessages: 0,
          tools: {},
        }),
      },
      conversation: { append: vi.fn() },
      getMessages: vi.fn(),
      updateConversation: vi.fn(),
    } as unknown as Session;
  }

  it("returns MastraContextBuilder", () => {
    const sess = fakeSession();
    const m = new MastraSession(sess, []);
    expect(m.context).toBeInstanceOf(MastraContextBuilder);
  });

  it("context chain .tools().assemble() returns MastraAssembledContext", async () => {
    const sess = fakeSession();
    const m = new MastraSession(sess, []);
    const ctx = await m.context
      .tools({ agentified_discover: m.discoverTool })
      .assemble();
    expect(ctx).toBeInstanceOf(MastraAssembledContext);
    expect(ctx.tools["agentified_discover"]).toBe(m.discoverTool);
  });
});
