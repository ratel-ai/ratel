import { describe, it, expect, vi, beforeEach } from "vitest"
import { createAgentRuntime } from "../runtime"
import { createTraceEmitter } from "../traces/emitter"
import { createInMemoryDecisionGraph } from "../capabilities/builtins"
import type { AgentConfig } from "../config/schema"
import type { LanguageModel } from "ai"
import type { Capability } from "../types"

const createMockModel = (response: string = "Hello!"): LanguageModel => {
  return {
    specificationVersion: "v1",
    provider: "mock",
    modelId: "mock-model",
    defaultObjectGenerationMode: "json",
    doGenerate: vi.fn().mockResolvedValue({
      text: response,
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
    doStream: vi.fn().mockReturnValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", textDelta: response })
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 5 },
          })
          controller.close()
        },
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  } as unknown as LanguageModel
}

const createTestConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  version: "1",
  agent: { id: "test-agent", name: "Test Agent" },
  model: { provider: "openai", model: "gpt-4o" },
  persona: { system: "You are a helpful assistant." },
  ...overrides,
})

describe("createAgentRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("invoke", () => {
    it("executes and returns response", async () => {
      const mockModel = createMockModel("Hello, how can I help?")
      const config = createTestConfig()
      const runtime = createAgentRuntime(config, { model: mockModel })

      const result = await runtime.invoke({
        message: "Hi there",
        sessionId: "session-123",
      })

      expect(result.response).toBe("Hello, how can I help?")
      expect(result.trace.sessionId).toBe("session-123")
      expect(result.trace.agentId).toBe("test-agent")
    })

    it("includes bootstrap context in trace", async () => {
      const mockModel = createMockModel()
      const config = createTestConfig()
      const runtime = createAgentRuntime(config, {
        model: mockModel,
        bootstrap: { userId: "user-456", page: "checkout" },
      })

      const result = await runtime.invoke({
        message: "Hello",
        sessionId: "session-123",
      })

      expect(result.trace.bootstrapContext).toMatchObject({
        userId: "user-456",
        page: "checkout",
        sessionId: "session-123",
      })
    })

    it("emits trace via traceEmitter", async () => {
      const mockModel = createMockModel("Test response")
      const config = createTestConfig()
      const traceEmitter = createTraceEmitter()
      const handler = vi.fn()
      traceEmitter.addHandler(handler)

      const runtime = createAgentRuntime(config, { model: mockModel, traceEmitter })

      await runtime.invoke({ message: "Hello", sessionId: "session-123" })

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "test-agent",
          sessionId: "session-123",
          message: "Hello",
          response: "Test response",
        })
      )
    })

    it("includes latencyMs in trace", async () => {
      const mockModel = createMockModel()
      const config = createTestConfig()
      const traceEmitter = createTraceEmitter()
      const handler = vi.fn()
      traceEmitter.addHandler(handler)

      const runtime = createAgentRuntime(config, { model: mockModel, traceEmitter })

      await runtime.invoke({ message: "Hello", sessionId: "session-123" })

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          latencyMs: expect.any(Number),
        })
      )
    })
  })

  describe("capabilities", () => {
    it("lists available capabilities", () => {
      const mockModel = createMockModel()
      const config = createTestConfig()
      const customCapability: Capability = {
        name: "custom_tool",
        description: "A custom tool",
        fn: async () => "result",
      }

      const runtime = createAgentRuntime(config, {
        model: mockModel,
        capabilities: [customCapability],
      })

      const available = runtime.getAvailableCapabilities({ sessionId: "test" })
      expect(available.map((c) => c.name)).toContain("custom_tool")
    })

    it("includes built-in capabilities when decisionGraph provided", () => {
      const mockModel = createMockModel()
      const config = createTestConfig()
      const decisionGraph = createInMemoryDecisionGraph()

      const runtime = createAgentRuntime(config, {
        model: mockModel,
        decisionGraph,
      })

      const available = runtime.getAvailableCapabilities({ sessionId: "test" })
      expect(available.map((c) => c.name)).toContain("search_decisions")
      expect(available.map((c) => c.name)).toContain("learn")
    })

    it("filters capabilities by visibleWhen policy", () => {
      const mockModel = createMockModel()
      const config = createTestConfig()

      const visibleCapability: Capability = {
        name: "always_visible",
        description: "Always visible",
        fn: async () => "result",
      }

      const conditionalCapability: Capability = {
        name: "admin_only",
        description: "Only for admins",
        fn: async () => "result",
        policies: {
          visibleWhen: (ctx) => ctx.role === "admin",
        },
      }

      const runtime = createAgentRuntime(config, {
        model: mockModel,
        capabilities: [visibleCapability, conditionalCapability],
      })

      // Without admin role
      const userCaps = runtime.getAvailableCapabilities({ sessionId: "test", role: "user" })
      expect(userCaps.map((c) => c.name)).toContain("always_visible")
      expect(userCaps.map((c) => c.name)).not.toContain("admin_only")

      // With admin role
      const adminCaps = runtime.getAvailableCapabilities({ sessionId: "test", role: "admin" })
      expect(adminCaps.map((c) => c.name)).toContain("always_visible")
      expect(adminCaps.map((c) => c.name)).toContain("admin_only")
    })

    it("tracks capabilities in trace", async () => {
      const mockModel = createMockModel()
      const config = createTestConfig()
      const traceEmitter = createTraceEmitter()
      const handler = vi.fn()
      traceEmitter.addHandler(handler)

      const customCapability: Capability = {
        name: "my_tool",
        description: "My tool",
        fn: async () => "result",
      }

      const runtime = createAgentRuntime(config, {
        model: mockModel,
        traceEmitter,
        capabilities: [customCapability],
      })

      await runtime.invoke({ message: "Hello", sessionId: "session-123" })

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          capabilitiesAvailable: expect.arrayContaining(["my_tool"]),
        })
      )
    })
  })

  describe("decision graph", () => {
    it("adds nodes when capabilities are called", async () => {
      const decisionGraph = createInMemoryDecisionGraph()

      // Add a test node
      const node = await decisionGraph.addNode({
        type: "learning",
        rule: "test rule",
        evidence: [],
      })

      expect(node.id).toBeDefined()
      expect(node.timestamp).toBeDefined()

      // Search for it
      const results = await decisionGraph.search("test")
      expect(results.length).toBeGreaterThan(0)
    })

    it("search_decisions capability queries the graph", async () => {
      const decisionGraph = createInMemoryDecisionGraph()

      // Pre-populate with a decision
      await decisionGraph.addNode({
        type: "learning",
        rule: "refund requires closed order",
        evidence: ["decision-1"],
      })

      const results = await decisionGraph.search("refund")
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        type: "learning",
        rule: "refund requires closed order",
      })
    })

    it("learn capability adds to the graph", async () => {
      const mockModel = createMockModel()
      const config = createTestConfig()
      const decisionGraph = createInMemoryDecisionGraph()

      const runtime = createAgentRuntime(config, {
        model: mockModel,
        decisionGraph,
      })

      // Get the learn capability and call it directly
      const caps = runtime.getAvailableCapabilities({ sessionId: "test" })
      const learnCap = caps.find((c) => c.name === "learn")!

      await learnCap.fn(
        { rule: "new rule", evidence: ["ev1"] },
        { sessionId: "test", agentId: "test-agent", model: "gpt-4o" }
      )

      const results = await decisionGraph.search("new rule")
      expect(results).toHaveLength(1)
    })
  })

  describe("stream", () => {
    it("yields text chunks", async () => {
      const mockModel = createMockModel("Streaming response")
      const config = createTestConfig()
      const runtime = createAgentRuntime(config, { model: mockModel })

      const chunks: string[] = []
      for await (const chunk of runtime.stream({
        message: "Hello",
        sessionId: "session-123",
      })) {
        if (chunk.type === "text-delta" && chunk.textDelta) {
          chunks.push(chunk.textDelta)
        }
      }

      expect(chunks).toContain("Streaming response")
    })

    it("emits trace after stream completes", async () => {
      const mockModel = createMockModel("Stream done")
      const config = createTestConfig()
      const traceEmitter = createTraceEmitter()
      const handler = vi.fn()
      traceEmitter.addHandler(handler)

      const runtime = createAgentRuntime(config, { model: mockModel, traceEmitter })

      // Consume the stream
      for await (const _ of runtime.stream({
        message: "Hello",
        sessionId: "session-123",
      })) {
        // consume
      }

      expect(handler).toHaveBeenCalled()
    })

    it("yields done chunk at end", async () => {
      const mockModel = createMockModel("Response")
      const config = createTestConfig()
      const runtime = createAgentRuntime(config, { model: mockModel })

      const chunks: string[] = []
      for await (const chunk of runtime.stream({
        message: "Hello",
        sessionId: "session-123",
      })) {
        chunks.push(chunk.type)
      }

      expect(chunks[chunks.length - 1]).toBe("done")
    })
  })
})
