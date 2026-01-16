import type { LanguageModel } from "ai"
import type { z } from "zod"

// Decision Graph Types
export type DecisionNode =
  | ActionDecision
  | QueryDecision
  | LearningDecision
  | ConstraintDecision

export interface ActionDecision {
  type: "action"
  id: string
  timestamp: Date
  capability: string
  args: unknown
  result: unknown
  success: boolean
  sessionId?: string
  entities?: string[]
}

export interface QueryDecision {
  type: "query"
  id: string
  timestamp: Date
  capability: string
  query: string
  results: unknown[]
  sessionId?: string
  entities?: string[]
}

export interface LearningDecision {
  type: "learning"
  id: string
  timestamp: Date
  rule: string
  evidence: string[] // IDs of decisions that led to this learning
  sessionId?: string
  entities?: string[]
}

export interface ConstraintDecision {
  type: "constraint"
  id: string
  timestamp: Date
  condition: string
  appliesTo: string // capability name
  sessionId?: string
  entities?: string[]
}

// Capability Types
export interface CapabilityPolicy {
  visibleWhen?: (context: BootstrapContext) => boolean
  requiresApproval?: (args: unknown) => boolean
  maxCallsPerSession?: number
}

export interface Capability<TArgs = unknown, TResult = unknown> {
  name: string
  description: string
  schema?: z.ZodType<TArgs> // Zod schema for args
  fn: (args: TArgs, context: InvocationContext) => Promise<TResult>
  policies?: CapabilityPolicy
}

// Context Types
export interface BootstrapContext {
  sessionId: string
  userId?: string
  [key: string]: unknown
}

export interface InvocationContext extends BootstrapContext {
  agentId: string
  model: string
}

// Decision Node creation types (without id/timestamp, those are added by graph)
export type CreateActionDecision = Omit<ActionDecision, "id" | "timestamp">
export type CreateQueryDecision = Omit<QueryDecision, "id" | "timestamp">
export type CreateLearningDecision = Omit<LearningDecision, "id" | "timestamp">
export type CreateConstraintDecision = Omit<ConstraintDecision, "id" | "timestamp">
export type CreateDecisionNode =
  | CreateActionDecision
  | CreateQueryDecision
  | CreateLearningDecision
  | CreateConstraintDecision

// Decision Graph Interface (platform provides implementation)
export interface DecisionGraph {
  search(query: string, options?: { limit?: number; entities?: string[] }): Promise<DecisionNode[]>
  addNode(node: CreateDecisionNode): Promise<DecisionNode>
  getById(id: string): Promise<DecisionNode | null>
}

// Trace Types (enhanced)
export interface Trace {
  id: string
  agentId: string
  sessionId?: string
  timestamp: Date
  message: string
  model: string
  bootstrapContext?: BootstrapContext
  capabilitiesAvailable?: string[]
  capabilitiesCalled?: CapabilityCall[]
  tokensUsed?: { input: number; output: number }
  latencyMs?: number
  response?: string
  decisionsCreated?: string[] // IDs of decision nodes created
}

export interface CapabilityCall {
  name: string
  args: unknown
  result: unknown
  success: boolean
  durationMs: number
}

export type TraceHandler = (trace: Trace) => Promise<void>

export interface TraceEmitter {
  emit(trace: Trace): Promise<void>
  addHandler(handler: TraceHandler): void
}

// Runtime Types
export interface AgentRuntimeOptions {
  model: LanguageModel
  bootstrap?: Partial<BootstrapContext>
  capabilities?: Capability[]
  decisionGraph?: DecisionGraph
  traceEmitter?: TraceEmitter
}

export interface InvokeParams {
  message: string
  sessionId: string
  context?: Record<string, unknown>
}

export interface InvokeResult {
  response: string
  trace: Trace
  capabilitiesCalled: CapabilityCall[]
  decisionsCreated: DecisionNode[]
}

export interface StreamChunk {
  type: "text-delta" | "capability-call" | "capability-result" | "done"
  textDelta?: string
  capability?: CapabilityCall
}

export interface AgentRuntime {
  invoke(params: InvokeParams): Promise<InvokeResult>
  stream(params: InvokeParams): AsyncIterable<StreamChunk>
  getAvailableCapabilities(context: BootstrapContext): Capability[]
}
