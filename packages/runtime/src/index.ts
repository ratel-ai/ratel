// Types
export type {
  // Decision Graph
  DecisionNode,
  ActionDecision,
  QueryDecision,
  LearningDecision,
  ConstraintDecision,
  DecisionGraph,
  // Capabilities
  Capability,
  CapabilityPolicy,
  CapabilityCall,
  // Context
  BootstrapContext,
  InvocationContext,
  // Runtime
  AgentRuntime,
  AgentRuntimeOptions,
  InvokeParams,
  InvokeResult,
  StreamChunk,
  // Traces
  Trace,
  TraceEmitter,
  TraceHandler,
} from "./types"

// Config
export { AgentConfigSchema, type AgentConfig, type Tool, type ModelConfig } from "./config/schema"
export { loadConfig, parseConfig } from "./config/loader"

// Runtime
export { createAgentRuntime } from "./runtime"

// Traces
export { createTraceEmitter } from "./traces/emitter"

// Capabilities
export {
  createSearchDecisionsCapability,
  createLearnCapability,
  createInMemoryDecisionGraph,
} from "./capabilities/builtins"

// Legacy exports (deprecated, will be removed)
export {
  executeAgent,
  streamAgent,
  type ExecutionResult,
  type ExecutionOptions,
  type StreamPart as LegacyStreamPart,
} from "./agent/executor"
export { assembleContext, type AssembledContext } from "./agent/context"
