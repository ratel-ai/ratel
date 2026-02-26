import type { ToolSlot } from "./tool-slots.js";

export interface BenchmarkToolCall {
  type?: "tool-call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface TestHarness {
  sendMessage: (
    history: Message[],
    seed: number,
    expectedTools?: ToolSlot[],
    turnId?: string,
  ) => Promise<AgentResponse>;
  cleanup?: () => Promise<void>;
}

export interface DebugInfo {
  systemPrompt: string;
  toolNames: string[];
  modelResponse: string;
  toolCallsMade: Array<{ name: string; args: Record<string, unknown> }>;
}

export interface AgentResponse {
  content: string;
  toolCalls: BenchmarkToolCall[];
  usage: TokenUsage;
  durationMs: number;
  hydratedTools?: string[];
  turnId?: string;
  debug?: DebugInfo;
}

export interface TokenUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  outputReasoningTokens?: number;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export type ScenarioType =
  | "retrieval"
  | "action"
  | "multi-turn"
  | "negative"
  | "ambiguous";

export type ScenarioCategory =
  | ScenarioType
  | "cross-domain"
  | "distractor"
  | "scale-stress";

export interface Scenario {
  id: number;
  query: string;
  expectedTools: ToolSlot[];
  type: ScenarioType;
  seed: number;
  category?: ScenarioCategory;
  expectedParams?: Record<string, Record<string, unknown>>;
  expectedOutcome?: string;
  followUps?: string[];
  skip?: boolean;
}

export interface BenchmarkInput {
  scenario: Scenario;
  harness: TestHarness;
}

export interface BenchmarkOutput {
  response: AgentResponse;
  scenario: Scenario;
}

export interface ScenarioResult {
  scenarioId: number;
  query: string;
  type: ScenarioType;
  category: string;
  expectedTools: ToolSlot[];
  toolsCalled: string[];
  response: string;
  scores: Record<string, number>;
  tcReasoning?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  outputReasoningTokens?: number;
  durationMs: number;
  cost: number;
}

export interface BenchmarkRunResult {
  agent: string;
  model: string;
  timestamp: string;
  scenarios: ScenarioResult[];
}

export type { ToolSlot } from "./tool-slots.js";
export type { Scorer, ScorerResult } from "../metrics/scorers.js";
