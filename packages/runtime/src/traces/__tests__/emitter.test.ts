import { describe, it, expect, vi } from "vitest"
import { createTraceEmitter } from "../emitter"
import type { Trace } from "../../types"

const createTestTrace = (overrides: Partial<Trace> = {}): Trace => ({
  id: "trace-123",
  agentId: "agent-1",
  timestamp: new Date("2024-01-01T00:00:00Z"),
  message: "Hello",
  model: "gpt-4o",
  ...overrides,
})

describe("TraceEmitter", () => {
  it("emit() calls registered handler", async () => {
    const handler = vi.fn()
    const emitter = createTraceEmitter()
    emitter.addHandler(handler)

    const trace = createTestTrace()
    await emitter.emit(trace)

    expect(handler).toHaveBeenCalledWith(trace)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("emit() works without handler (no-op)", async () => {
    const emitter = createTraceEmitter()
    const trace = createTestTrace()

    await expect(emitter.emit(trace)).resolves.toBeUndefined()
  })

  it("emit() calls multiple handlers", async () => {
    const handler1 = vi.fn()
    const handler2 = vi.fn()
    const emitter = createTraceEmitter()

    emitter.addHandler(handler1)
    emitter.addHandler(handler2)

    const trace = createTestTrace()
    await emitter.emit(trace)

    expect(handler1).toHaveBeenCalledWith(trace)
    expect(handler2).toHaveBeenCalledWith(trace)
  })

  it("trace has expected shape with all fields", async () => {
    const handler = vi.fn()
    const emitter = createTraceEmitter()
    emitter.addHandler(handler)

    const trace: Trace = {
      id: "trace-456",
      agentId: "agent-2",
      sessionId: "session-789",
      timestamp: new Date("2024-01-01T12:00:00Z"),
      message: "What is 2+2?",
      bootstrapContext: { sessionId: "session-789", memory: { turns: 5 } },
      capabilitiesAvailable: ["calculator", "search"],
      model: "claude-3-5-sonnet-20241022",
      capabilitiesCalled: [
        { name: "calculator", args: { expr: "2+2" }, result: 4, success: true, durationMs: 100 },
      ],
      tokensUsed: { input: 100, output: 50 },
      latencyMs: 1500,
      response: "The answer is 4.",
    }

    await emitter.emit(trace)

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "trace-456",
        agentId: "agent-2",
        sessionId: "session-789",
        message: "What is 2+2?",
        model: "claude-3-5-sonnet-20241022",
        response: "The answer is 4.",
        tokensUsed: { input: 100, output: 50 },
        latencyMs: 1500,
      })
    )
  })

  it("handlers are called in order", async () => {
    const calls: number[] = []
    const emitter = createTraceEmitter()

    emitter.addHandler(async () => {
      calls.push(1)
    })
    emitter.addHandler(async () => {
      calls.push(2)
    })
    emitter.addHandler(async () => {
      calls.push(3)
    })

    await emitter.emit(createTestTrace())

    expect(calls).toEqual([1, 2, 3])
  })

  it("handler errors do not prevent other handlers from running", async () => {
    const handler1 = vi.fn().mockRejectedValue(new Error("Handler 1 failed"))
    const handler2 = vi.fn()
    const emitter = createTraceEmitter()

    emitter.addHandler(handler1)
    emitter.addHandler(handler2)

    const trace = createTestTrace()
    await emitter.emit(trace)

    expect(handler1).toHaveBeenCalled()
    expect(handler2).toHaveBeenCalled()
  })
})
