import { generateText, streamText, tool } from "ai"
import { z } from "zod"
import type { AgentConfig } from "./config/schema"
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  BootstrapContext,
  Capability,
  CapabilityCall,
  DecisionNode,
  InvocationContext,
  InvokeParams,
  InvokeResult,
  StreamChunk,
  Trace,
} from "./types"
import { createSearchDecisionsCapability, createLearnCapability } from "./capabilities/builtins"

export function createAgentRuntime(
  config: AgentConfig,
  options: AgentRuntimeOptions
): AgentRuntime {
  const { model, bootstrap = {}, capabilities = [], decisionGraph, traceEmitter } = options

  // Add built-in capabilities if decisionGraph provided
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allCapabilities: Capability<any, any>[] = [...capabilities]
  if (decisionGraph) {
    allCapabilities.push(createSearchDecisionsCapability(decisionGraph))
    allCapabilities.push(createLearnCapability(decisionGraph))
  }

  function getAvailableCapabilities(context: BootstrapContext): Capability[] {
    return allCapabilities.filter((cap) => {
      if (!cap.policies?.visibleWhen) return true
      return cap.policies.visibleWhen(context)
    })
  }

  function capabilitiesToTools(
    caps: Capability[],
    context: InvocationContext,
    callTracker: CapabilityCall[],
    decisionTracker: DecisionNode[]
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Record<string, any> = {}

    for (const cap of caps) {
      tools[cap.name] = tool({
        description: cap.description,
        parameters: cap.schema ?? z.object({}),
        execute: async (args: unknown) => {
          const startTime = Date.now()
          let result: unknown
          let success = true

          try {
            result = await cap.fn(args, context)
          } catch (error) {
            success = false
            result = error instanceof Error ? error.message : String(error)
          }

          const durationMs = Date.now() - startTime

          const call: CapabilityCall = {
            name: cap.name,
            args,
            result,
            success,
            durationMs,
          }
          callTracker.push(call)

          // Record as decision node if we have a decision graph
          if (decisionGraph) {
            const node = await decisionGraph.addNode({
              type: "action",
              capability: cap.name,
              args,
              result,
              success,
              sessionId: context.sessionId,
            })
            decisionTracker.push(node)
          }

          return result
        },
      })
    }

    return tools
  }

  async function invoke(params: InvokeParams): Promise<InvokeResult> {
    const startTime = Date.now()
    const { message, sessionId, context: additionalContext = {} } = params

    const bootstrapContext: BootstrapContext = {
      ...bootstrap,
      ...additionalContext,
      sessionId,
    }

    const invocationContext: InvocationContext = {
      ...bootstrapContext,
      agentId: config.agent.id,
      model: config.model.model,
    }

    const availableCapabilities = getAvailableCapabilities(bootstrapContext)
    const capabilitiesCalled: CapabilityCall[] = []
    const decisionsCreated: DecisionNode[] = []

    const tools = capabilitiesToTools(
      availableCapabilities,
      invocationContext,
      capabilitiesCalled,
      decisionsCreated
    )

    const result = await generateText({
      model,
      system: config.persona.system,
      prompt: message,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      maxSteps: 10, // Allow multi-step tool use
    })

    const latencyMs = Date.now() - startTime

    const trace: Trace = {
      id: crypto.randomUUID(),
      agentId: config.agent.id,
      sessionId,
      timestamp: new Date(),
      message,
      model: config.model.model,
      bootstrapContext,
      capabilitiesAvailable: availableCapabilities.map((c) => c.name),
      capabilitiesCalled,
      tokensUsed: {
        input: result.usage.promptTokens,
        output: result.usage.completionTokens,
      },
      latencyMs,
      response: result.text,
      decisionsCreated: decisionsCreated.map((d) => d.id),
    }

    if (traceEmitter) {
      await traceEmitter.emit(trace)
    }

    return {
      response: result.text,
      trace,
      capabilitiesCalled,
      decisionsCreated,
    }
  }

  async function* stream(params: InvokeParams): AsyncIterable<StreamChunk> {
    const startTime = Date.now()
    const { message, sessionId, context: additionalContext = {} } = params

    const bootstrapContext: BootstrapContext = {
      ...bootstrap,
      ...additionalContext,
      sessionId,
    }

    const invocationContext: InvocationContext = {
      ...bootstrapContext,
      agentId: config.agent.id,
      model: config.model.model,
    }

    const availableCapabilities = getAvailableCapabilities(bootstrapContext)
    const capabilitiesCalled: CapabilityCall[] = []
    const decisionsCreated: DecisionNode[] = []

    const tools = capabilitiesToTools(
      availableCapabilities,
      invocationContext,
      capabilitiesCalled,
      decisionsCreated
    )

    let fullResponse = ""
    let promptTokens = 0
    let completionTokens = 0

    const result = streamText({
      model,
      system: config.persona.system,
      prompt: message,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      maxSteps: 10,
    })

    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") {
        fullResponse += chunk.textDelta
        yield { type: "text-delta", textDelta: chunk.textDelta }
      } else if (chunk.type === "tool-call") {
        yield {
          type: "capability-call",
          capability: {
            name: chunk.toolName,
            args: chunk.args,
            result: undefined,
            success: true,
            durationMs: 0,
          },
        }
      } else if (chunk.type === "finish") {
        promptTokens = chunk.usage.promptTokens
        completionTokens = chunk.usage.completionTokens
      }
    }

    const latencyMs = Date.now() - startTime

    const trace: Trace = {
      id: crypto.randomUUID(),
      agentId: config.agent.id,
      sessionId,
      timestamp: new Date(),
      message,
      model: config.model.model,
      bootstrapContext,
      capabilitiesAvailable: availableCapabilities.map((c) => c.name),
      capabilitiesCalled,
      tokensUsed: { input: promptTokens, output: completionTokens },
      latencyMs,
      response: fullResponse,
      decisionsCreated: decisionsCreated.map((d) => d.id),
    }

    if (traceEmitter) {
      await traceEmitter.emit(trace)
    }

    yield { type: "done" }
  }

  return {
    invoke,
    stream,
    getAvailableCapabilities,
  }
}
