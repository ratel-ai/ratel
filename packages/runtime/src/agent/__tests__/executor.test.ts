import { describe, it, expect, vi, beforeEach } from "vitest"
import { executeAgent, streamAgent } from "../executor"
import { createTraceEmitter } from "../../traces/emitter"
import type { AgentConfig } from "../../config/schema"
import type { LanguageModel } from "ai"

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

describe("executeAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("executes with minimal config and returns response", async () => {
    const mockModel = createMockModel("Hello, how can I help?")
    const config = createTestConfig()

    const result = await executeAgent(config, "Hi there", { model: mockModel })

    expect(result.response).toBe("Hello, how can I help?")
    expect(result.finishReason).toBe("stop")
  })

  it("uses persona system prompt", async () => {
    const mockModel = createMockModel()
    const config = createTestConfig({
      persona: { system: "You are a pirate." },
    })

    await executeAgent(config, "Hello", { model: mockModel })

    expect(mockModel.doGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: "You are a pirate.",
          }),
        ]),
      })
    )
  })

  it("includes token usage in result", async () => {
    const mockModel = createMockModel()
    const config = createTestConfig()

    const result = await executeAgent(config, "Hello", { model: mockModel })

    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    })
  })

  it("emits trace on completion", async () => {
    const mockModel = createMockModel("Test response")
    const config = createTestConfig()
    const traceEmitter = createTraceEmitter()
    const handler = vi.fn()
    traceEmitter.addHandler(handler)

    await executeAgent(config, "Hello", {
      model: mockModel,
      traceEmitter,
      sessionId: "session-123",
    })

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "test-agent",
        sessionId: "session-123",
        message: "Hello",
        model: "gpt-4o",
        response: "Test response",
        tokensUsed: { input: 10, output: 5 },
      })
    )
  })

  it("includes latencyMs in trace", async () => {
    const mockModel = createMockModel()
    const config = createTestConfig()
    const traceEmitter = createTraceEmitter()
    const handler = vi.fn()
    traceEmitter.addHandler(handler)

    await executeAgent(config, "Hello", { model: mockModel, traceEmitter })

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        latencyMs: expect.any(Number),
      })
    )
  })

  it("includes tools in trace when config has tools", async () => {
    const mockModel = createMockModel()
    const config = createTestConfig({
      tools: [
        { name: "search", type: "http", description: "Search web" },
        { name: "calc", type: "function", description: "Calculate" },
      ],
    })
    const traceEmitter = createTraceEmitter()
    const handler = vi.fn()
    traceEmitter.addHandler(handler)

    await executeAgent(config, "Hello", { model: mockModel, traceEmitter })

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilitiesAvailable: ["search", "calc"],
      })
    )
  })
})

describe("streamAgent", () => {
  it("yields text chunks from stream", async () => {
    const mockModel = createMockModel("Streaming response")
    const config = createTestConfig()

    const chunks: string[] = []
    for await (const chunk of streamAgent(config, "Hello", { model: mockModel })) {
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

    const chunks: unknown[] = []
    for await (const chunk of streamAgent(config, "Hello", {
      model: mockModel,
      traceEmitter,
    })) {
      chunks.push(chunk)
    }

    expect(handler).toHaveBeenCalled()
  })
})
