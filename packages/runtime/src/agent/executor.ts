import { generateText, streamText, type LanguageModel } from "ai"
import type { AgentConfig } from "../config/schema"
import type { Trace, TraceEmitter } from "../types"
import { assembleContext } from "./context"

export interface ExecutionResult {
  response: string
  finishReason: string
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface ExecutionOptions {
  model: LanguageModel
  traceEmitter?: TraceEmitter
  sessionId?: string
}

export interface StreamPart {
  type: string
  textDelta?: string
}

export async function executeAgent(
  config: AgentConfig,
  message: string,
  options: ExecutionOptions
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const context = assembleContext(config)

  const result = await generateText({
    model: options.model,
    system: context.systemPrompt,
    prompt: message,
  })

  const latencyMs = Date.now() - startTime

  if (options.traceEmitter) {
    const trace: Trace = {
      id: crypto.randomUUID(),
      agentId: config.agent.id,
      sessionId: options.sessionId,
      timestamp: new Date(),
      message,
      model: config.model.model,
      response: result.text,
      tokensUsed: {
        input: result.usage.promptTokens,
        output: result.usage.completionTokens,
      },
      latencyMs,
      capabilitiesAvailable: context.toolNames.length > 0 ? context.toolNames : undefined,
    }
    await options.traceEmitter.emit(trace)
  }

  return {
    response: result.text,
    finishReason: result.finishReason,
    usage: {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.promptTokens + result.usage.completionTokens,
    },
  }
}

export async function* streamAgent(
  config: AgentConfig,
  message: string,
  options: ExecutionOptions
): AsyncIterable<StreamPart> {
  const startTime = Date.now()
  const context = assembleContext(config)
  let fullResponse = ""
  let promptTokens = 0
  let completionTokens = 0

  const result = streamText({
    model: options.model,
    system: context.systemPrompt,
    prompt: message,
  })

  for await (const chunk of result.fullStream) {
    if (chunk.type === "text-delta") {
      fullResponse += chunk.textDelta
      yield { type: "text-delta", textDelta: chunk.textDelta }
    } else if (chunk.type === "finish") {
      promptTokens = chunk.usage.promptTokens
      completionTokens = chunk.usage.completionTokens
    }
  }

  const latencyMs = Date.now() - startTime

  if (options.traceEmitter) {
    const trace: Trace = {
      id: crypto.randomUUID(),
      agentId: config.agent.id,
      sessionId: options.sessionId,
      timestamp: new Date(),
      message,
      model: config.model.model,
      response: fullResponse,
      tokensUsed: { input: promptTokens, output: completionTokens },
      latencyMs,
      capabilitiesAvailable: context.toolNames.length > 0 ? context.toolNames : undefined,
    }
    await options.traceEmitter.emit(trace)
  }
}
