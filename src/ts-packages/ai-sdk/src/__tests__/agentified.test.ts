import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTool = vi.fn(({ description, execute }: any) => ({
  description,
  execute,
  __aiSdkTool: true,
}));

vi.mock("ai", () => ({
  tool: (...args: any[]) => mockTool(...args),
}));

import {
  aiSdk,
  AiSdkAgentified,
  AiSdkInstance,
  AiSdkSession,
  AiSdkNamespace,
  AiSdkDatasetRef,
  AiSdkContextBuilder,
  AiSdkAssembledContext,
} from "../agentified.js";
import type { Agentified, Instance, Session, Namespace, DatasetRef, ContextBuilder } from "agentified";

describe("aiSdk() adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns object with adapt method", () => {
    const adapter = aiSdk();
    expect(adapter).toHaveProperty("adapt");
    expect(typeof adapter.adapt).toBe("function");
  });

  it("adapt wraps Agentified into AiSdkAgentified", () => {
    const fakeAg = {} as Agentified;
    const result = aiSdk().adapt(fakeAg);
    expect(result).toBeInstanceOf(AiSdkAgentified);
  });
});

describe("AiSdkAgentified", () => {
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
    const m = new AiSdkAgentified(ag);
    await m.connect("http://localhost:9119");
    expect(ag.connect).toHaveBeenCalledWith("http://localhost:9119", undefined);
  });

  it("delegates disconnect()", async () => {
    const ag = fakeAgentified();
    const m = new AiSdkAgentified(ag);
    await m.disconnect();
    expect(ag.disconnect).toHaveBeenCalled();
  });

  it("dataset() returns AiSdkDatasetRef", () => {
    const ag = fakeAgentified();
    const fakeRef = {} as DatasetRef;
    (ag.dataset as ReturnType<typeof vi.fn>).mockReturnValue(fakeRef);

    const m = new AiSdkAgentified(ag);
    const ref = m.dataset("test");
    expect(ref).toBeInstanceOf(AiSdkDatasetRef);
    expect(ag.dataset).toHaveBeenCalledWith("test");
  });

  it("register() returns AiSdkInstance", async () => {
    const ag = fakeAgentified();
    const fakeInstance = {
      instanceId: "default",
      datasetId: "default",
      discoverTool: {
        definition: { name: "agentified_discover", description: "Find tools", parameters: {} },
        execute: vi.fn(),
        discoveredNames: new Set<string>(),
      },
      prepareStep: vi.fn(),
      session: vi.fn(),
      namespace: vi.fn(),
    } as unknown as Instance;
    (ag.register as ReturnType<typeof vi.fn>).mockResolvedValue(fakeInstance);

    const m = new AiSdkAgentified(ag);
    const inst = await m.register({ tools: [] });
    expect(inst).toBeInstanceOf(AiSdkInstance);
  });
});

describe("AiSdkInstance", () => {
  function fakeInstance() {
    return {
      instanceId: "my-dataset",
      datasetId: "my-dataset",
      discoverTool: {
        definition: { name: "agentified_discover", description: "Find tools", parameters: {} },
        execute: vi.fn().mockResolvedValue([{ name: "tool1", score: 0.9 }]),
        discoveredNames: new Set<string>(),
      },
      prepareStep: vi.fn().mockResolvedValue({ activeTools: ["agentified_discover"] }),
      session: vi.fn(),
      namespace: vi.fn(),
    } as unknown as Instance;
  }

  it("wraps discoverTool with ai tool()", () => {
    const inst = fakeInstance();
    const m = new AiSdkInstance(inst, []);
    expect(m.discoverTool.__aiSdkTool).toBe(true);
    expect(mockTool).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Find tools" }),
    );
  });

  it("exposes tools property with discover + backend tools", () => {
    const backendTools = [{
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: {} },
      handler: vi.fn(),
    }];
    const inst = fakeInstance();
    const m = new AiSdkInstance(inst, backendTools);

    expect(m.tools["agentified_discover"]).toBe(m.discoverTool);
    expect(m.tools["get_weather"]).toBeDefined();
    expect(m.tools["get_weather"].__aiSdkTool).toBe(true);
  });

  it("exposes MCP tools in .tools alongside backend tools via register()", async () => {
    const ag = {
      connect: vi.fn(), disconnect: vi.fn(), dataset: vi.fn(),
      register: vi.fn().mockResolvedValue({
        instanceId: "default", datasetId: "default",
        discoverTool: {
          definition: { name: "agentified_discover", description: "Find tools", parameters: {} },
          execute: vi.fn(), discoveredNames: new Set<string>(),
        },
        prepareStep: vi.fn(), session: vi.fn(), namespace: vi.fn(),
      }),
    } as unknown as Agentified;

    const m = new AiSdkAgentified(ag);
    const inst = await m.register({
      tools: [
        { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: {} }, handler: vi.fn() },
        { name: "mcp_search", description: "Search via MCP", parameters: { type: "object", properties: {} }, type: "mcp" as const, server: "http://localhost:3001/mcp", handler: vi.fn() },
      ],
    });

    expect(inst.tools["get_weather"].__aiSdkTool).toBe(true);
    expect(inst.tools["mcp_search"].__aiSdkTool).toBe(true);
  });

  it("prepareStep returns { activeTools } (not { tools })", async () => {
    const inst = fakeInstance();
    const m = new AiSdkInstance(inst, []);

    const result = await m.prepareStep({ stepNumber: 0, steps: [] });
    expect(result.activeTools).toEqual(["agentified_discover"]);
    expect((result as any).tools).toBeUndefined();
  });

  it("prepareStep delegates to SDK instance prepareStep", async () => {
    const inst = fakeInstance();
    const m = new AiSdkInstance(inst, []);
    await m.prepareStep({ stepNumber: 1, steps: [{ text: "hi" }] });
    expect(inst.prepareStep).toHaveBeenCalledWith({ stepNumber: 1, steps: [{ text: "hi" }] });
  });

  it("exposes instanceId and datasetId", () => {
    const inst = fakeInstance();
    const m = new AiSdkInstance(inst, []);
    expect(m.instanceId).toBe("my-dataset");
    expect(m.datasetId).toBe("my-dataset");
  });

  it("session() returns AiSdkSession", () => {
    const inst = fakeInstance();
    const fakeSession = {
      id: "chat-1",
      namespaceId: "default",
      discoverTool: {
        definition: { name: "agentified_discover", description: "Find tools", parameters: {} },
        execute: vi.fn(),
        discoveredNames: new Set<string>(),
      },
      getMessagesTool: {
        definition: { name: "agentified_get_messages", description: "Get messages", parameters: {} },
        execute: vi.fn().mockResolvedValue({ messages: [], hasMore: false, maxSeq: 0 }),
      },
      prepareStep: vi.fn(),
      context: {},
      conversation: {},
      getMessages: vi.fn(),
      updateConversation: vi.fn(),
    } as unknown as Session;
    (inst.session as ReturnType<typeof vi.fn>).mockReturnValue(fakeSession);

    const m = new AiSdkInstance(inst, []);
    const session = m.session("chat-1");
    expect(session).toBeInstanceOf(AiSdkSession);
    expect(inst.session).toHaveBeenCalledWith("chat-1");
  });

  it("namespace() returns AiSdkNamespace", () => {
    const inst = fakeInstance();
    const fakeNs = { id: "user-1", session: vi.fn() } as unknown as Namespace;
    (inst.namespace as ReturnType<typeof vi.fn>).mockReturnValue(fakeNs);

    const m = new AiSdkInstance(inst, []);
    const ns = m.namespace("user-1");
    expect(ns).toBeInstanceOf(AiSdkNamespace);
    expect(inst.namespace).toHaveBeenCalledWith("user-1");
  });
});

describe("AiSdkSession", () => {
  function fakeSession() {
    return {
      id: "chat-1",
      namespaceId: "default",
      discoverTool: {
        definition: { name: "agentified_discover", description: "Find tools", parameters: {} },
        execute: vi.fn(),
        discoveredNames: new Set<string>(),
      },
      getMessagesTool: {
        definition: { name: "agentified_get_messages", description: "Get messages", parameters: {} },
        execute: vi.fn().mockResolvedValue({ messages: [], hasMore: false, maxSeq: 0 }),
      },
      prepareStep: vi.fn().mockResolvedValue({ activeTools: ["agentified_discover", "agentified_get_messages"] }),
      context: { messages: vi.fn().mockReturnThis(), recall: vi.fn().mockReturnThis(), assemble: vi.fn() },
      conversation: { append: vi.fn() },
      getMessages: vi.fn(),
      updateConversation: vi.fn(),
    } as unknown as Session;
  }

  it("wraps discoverTool with ai tool()", () => {
    const sess = fakeSession();
    const m = new AiSdkSession(sess, []);
    expect(m.discoverTool.__aiSdkTool).toBe(true);
  });

  it("wraps getMessagesTool with ai tool()", () => {
    const sess = fakeSession();
    const m = new AiSdkSession(sess, []);
    expect(m.getMessagesTool.__aiSdkTool).toBe(true);
    expect(mockTool).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Get messages" }),
    );
  });

  it("exposes tools property with discover + getMessages + backend tools", () => {
    const backendTools = [{
      name: "search_docs",
      description: "Search docs",
      parameters: { type: "object", properties: {} },
      handler: vi.fn(),
    }];
    const sess = fakeSession();
    const m = new AiSdkSession(sess, backendTools);

    expect(m.tools["agentified_discover"]).toBe(m.discoverTool);
    expect(m.tools["agentified_get_messages"]).toBe(m.getMessagesTool);
    expect(m.tools["search_docs"]).toBeDefined();
    expect(m.tools["search_docs"].__aiSdkTool).toBe(true);
  });

  it("prepareStep returns { activeTools } and delegates to SDK", async () => {
    const sess = fakeSession();
    const m = new AiSdkSession(sess, []);

    const result = await m.prepareStep({ stepNumber: 0, steps: [] });
    expect(result.activeTools).toEqual(["agentified_discover", "agentified_get_messages"]);
    expect((result as any).tools).toBeUndefined();
    expect(sess.prepareStep).toHaveBeenCalledWith({ stepNumber: 0, steps: [] });
  });

  it("flushMessages calls prepareStep with full steps array", async () => {
    const sess = fakeSession();
    const m = new AiSdkSession(sess, []);

    const steps = [{ text: "hello" }, { text: "world" }];
    await m.flushMessages(steps);
    expect(sess.prepareStep).toHaveBeenCalledWith({ stepNumber: 2, steps });
  });

  it("exposes id, conversation", () => {
    const sess = fakeSession();
    const m = new AiSdkSession(sess, []);
    expect(m.id).toBe("chat-1");
    expect(m.conversation).toBe(sess.conversation);
  });

  it("delegates getMessages", async () => {
    const sess = fakeSession();
    const m = new AiSdkSession(sess, []);
    await m.getMessages({ strategy: "recent" });
    expect(sess.getMessages).toHaveBeenCalledWith({ strategy: "recent" });
  });

  it("delegates updateConversation", async () => {
    const sess = fakeSession();
    const m = new AiSdkSession(sess, []);
    const input = { messages: [{ role: "user", content: "hi" }] };
    await m.updateConversation(input);
    expect(sess.updateConversation).toHaveBeenCalledWith(input);
  });
});

describe("AiSdkNamespace", () => {
  it("exposes id and returns AiSdkSession from session()", () => {
    const fakeSession = {
      id: "chat-1",
      discoverTool: {
        definition: { name: "agentified_discover", description: "d", parameters: {} },
        execute: vi.fn(),
        discoveredNames: new Set<string>(),
      },
      getMessagesTool: {
        definition: { name: "agentified_get_messages", description: "Get messages", parameters: {} },
        execute: vi.fn().mockResolvedValue({ messages: [], hasMore: false, maxSeq: 0 }),
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

    const m = new AiSdkNamespace(fakeNs, []);
    expect(m.id).toBe("user-1");
    const session = m.session("chat-1");
    expect(session).toBeInstanceOf(AiSdkSession);
  });
});

describe("AiSdkContextBuilder", () => {
  function fakeContextBuilder() {
    return {
      tools: vi.fn().mockReturnThis(),
      messages: vi.fn().mockReturnThis(),
      recall: vi.fn().mockReturnThis(),
      limitTokens: vi.fn().mockReturnThis(),
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
    const discoverTool = { __aiSdkTool: true } as any;
    const builder = new AiSdkContextBuilder(
      sdkBuilder, vi.fn(), discoverTool, new Set(), {},
    );
    const result = builder.tools({ my_tool: discoverTool });
    expect(result).toBe(builder);
  });

  it("messages() delegates to SDK builder", () => {
    const sdkBuilder = fakeContextBuilder();
    const builder = new AiSdkContextBuilder(
      sdkBuilder, vi.fn(), {} as any, new Set(), {},
    );
    builder.messages({ strategy: "recent" });
    expect(sdkBuilder.messages).toHaveBeenCalledWith({ strategy: "recent" });
  });

  it("recall() delegates to SDK builder", () => {
    const sdkBuilder = fakeContextBuilder();
    const builder = new AiSdkContextBuilder(
      sdkBuilder, vi.fn(), {} as any, new Set(), {},
    );
    builder.recall();
    expect(sdkBuilder.recall).toHaveBeenCalled();
  });

  it("limitTokens() delegates to SDK builder", () => {
    const sdkBuilder = fakeContextBuilder();
    const builder = new AiSdkContextBuilder(
      sdkBuilder, vi.fn(), {} as any, new Set(), {},
    );
    builder.limitTokens(4000);
    expect(sdkBuilder.limitTokens).toHaveBeenCalledWith(4000);
  });

  it("assemble() returns AiSdkAssembledContext with explicit + discovered tools", async () => {
    const sdkBuilder = fakeContextBuilder();
    const myTool = { __aiSdkTool: true } as any;
    const cachedTool = { __aiSdkTool: true } as any;
    const discoverTool = { __aiSdkTool: true } as any;
    const discoveredNames = new Set(["cached_tool"]);
    const toolCache = { cached_tool: cachedTool };

    const builder = new AiSdkContextBuilder(
      sdkBuilder, vi.fn(), discoverTool, discoveredNames, toolCache,
    );
    builder.tools({ my_tool: myTool });

    const ctx = await builder.assemble();
    expect(ctx).toBeInstanceOf(AiSdkAssembledContext);
    expect(ctx.tools["my_tool"]).toBe(myTool);
    expect(ctx.tools["cached_tool"]).toBe(cachedTool);
  });
});

describe("AiSdkAssembledContext", () => {
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
    const ctx = new AiSdkAssembledContext(sdkCtx, {}, vi.fn());
    expect(ctx.messages).toBe(sdkCtx.messages);
    expect(ctx.recalled).toBe(sdkCtx.recalled);
    expect(ctx.strategyUsed).toBe("recent");
    expect(ctx.fallback).toBe(false);
    expect(ctx.tokenEstimate).toBe(42);
  });

  it("prepareStep delegates to SDK and returns { activeTools }", async () => {
    const sdkPrepareStep = vi.fn().mockResolvedValue({ activeTools: ["agentified_discover", "tool1"] });
    const tools = { agentified_discover: {} as any, tool1: {} as any };
    const sdkCtx = {
      messages: [], recalled: { tools: [], memories: [] },
      strategyUsed: "recent" as const, fallback: false,
      tokenEstimate: 0, conversationMessages: 0,
      totalMessages: 0, includedMessages: 0, tools: {},
    };
    const ctx = new AiSdkAssembledContext(sdkCtx, tools, sdkPrepareStep);
    const result = await ctx.prepareStep({ stepNumber: 1, steps: [] });
    expect(sdkPrepareStep).toHaveBeenCalledWith({ stepNumber: 1, steps: [] });
    expect(result.activeTools).toEqual(["agentified_discover", "tool1"]);
    expect((result as any).tools).toBeUndefined();
  });

  it("flushMessages calls prepareStep with full steps array", async () => {
    const sdkPrepareStep = vi.fn().mockResolvedValue({ activeTools: [] });
    const sdkCtx = {
      messages: [], recalled: { tools: [], memories: [] },
      strategyUsed: "recent" as const, fallback: false,
      tokenEstimate: 0, conversationMessages: 0,
      totalMessages: 0, includedMessages: 0, tools: {},
    };
    const ctx = new AiSdkAssembledContext(sdkCtx, {}, sdkPrepareStep);
    const steps = [{ text: "a" }, { text: "b" }];
    await ctx.flushMessages(steps);
    expect(sdkPrepareStep).toHaveBeenCalledWith({ stepNumber: 2, steps });
  });
});

describe("AiSdkSession.context", () => {
  function fakeSession() {
    return {
      id: "chat-1",
      namespaceId: "default",
      discoverTool: {
        definition: { name: "agentified_discover", description: "Find tools", parameters: {} },
        execute: vi.fn(),
        discoveredNames: new Set<string>(),
      },
      getMessagesTool: {
        definition: { name: "agentified_get_messages", description: "Get messages", parameters: {} },
        execute: vi.fn().mockResolvedValue({ messages: [], hasMore: false, maxSeq: 0 }),
      },
      prepareStep: vi.fn(),
      context: {
        tools: vi.fn().mockReturnThis(),
        messages: vi.fn().mockReturnThis(),
        recall: vi.fn().mockReturnThis(),
        limitTokens: vi.fn().mockReturnThis(),
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

  it("returns AiSdkContextBuilder", () => {
    const sess = fakeSession();
    const m = new AiSdkSession(sess, []);
    expect(m.context).toBeInstanceOf(AiSdkContextBuilder);
  });

  it("context chain .tools().assemble() returns AiSdkAssembledContext", async () => {
    const sess = fakeSession();
    const m = new AiSdkSession(sess, []);
    const ctx = await m.context
      .tools({ agentified_discover: m.discoverTool })
      .assemble();
    expect(ctx).toBeInstanceOf(AiSdkAssembledContext);
    expect(ctx.tools["agentified_discover"]).toBe(m.discoverTool);
  });
});
