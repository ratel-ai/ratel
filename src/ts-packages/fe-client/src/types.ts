import type { BaseEvent, CustomEvent, AbstractAgent } from "@ag-ui/client";
export type { Message, Context } from "@ag-ui/client";

// Client config

export interface AgentifiedClientConfig {
  agentUrl: string;
  headers?: Record<string, string>;
  contextWindowSize?: number;
  maxEventLogSize?: number;
  /** @internal */
  _agentFactory?: (url: string, headers?: Record<string, string>) => AbstractAgent;
}

// Agentified event data (mirrors SDK event shapes)

export interface TokenUsage {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
}

export interface AgentifiedTool {
  name: string;
  description: string;
  score: number;
  [key: string]: unknown;
}

export interface PrefetchResult {
  tools: AgentifiedTool[];
  durationMs: number;
  skipped?: boolean;
  tokenUsage?: TokenUsage;
}

export interface DiscoveryResult {
  query: string;
  tools: AgentifiedTool[];
  durationMs: number;
  tokenUsage?: TokenUsage;
}

// Frontend tool handler

export type FrontendToolHandler = (args: unknown) => Promise<unknown>;

// Tool call tracking

export interface ToolCallDetail {
  id: string;
  name: string;
  args: string;
  result?: string;
  parentMessageId?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
}

// Inspector state

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface RunInfo {
  runId?: string;
  threadId?: string;
  startedAt?: number;
  durationMs?: number;
}

export interface AgentifiedInteractions {
  prefetchResults: PrefetchResult[];
  discoveries: DiscoveryResult[];
  currentTools: AgentifiedTool[];
}

export interface TokenState {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  contextWindowPercent?: number;
}

export interface StreamingMetrics {
  messageCount: number;
  toolCallCount: number;
  timeToFirstTokenMs?: number;
}

export interface EventLogEntry {
  timestamp: number;
  event: BaseEvent;
  isAgentified: boolean;
}

export interface SharedContext {
  page: string;
  openModals: string[];
  activeTab?: string;
}

// Skills (molecules composed of tool atoms) — Inspector v2

export interface RegisteredSkill {
  name: string;
  description: string;
  intent?: string;
  atoms: string[];
}

export interface SkillActivation {
  skillName: string;
  firstActivatedAt: number;
  toolCallIds: string[];
  reasoning?: string;
}

export interface SkillSuggestion {
  /** Tool names (sorted) that co-occur across runs. */
  toolNames: string[];
  /** Number of distinct runs in which all of these tools fired together. */
  cooccurrenceCount: number;
  /** Suggested name for the proposed skill. */
  proposedName: string;
  /** Human-readable rationale. */
  rationale: string;
}

export type ReliabilityIssueType = "retry" | "failure";

export interface ReliabilityIssue {
  toolName: string;
  type: ReliabilityIssueType;
  count: number;
  lastSeen: number;
  detail?: string;
}

export interface SkillsState {
  registered: RegisteredSkill[];
  activations: SkillActivation[];
  suggestions: SkillSuggestion[];
  reliability: ReliabilityIssue[];
}

// Token + cost panel — the "Ramp for agents" view

export interface CostConfig {
  /** USD per million input tokens. */
  inputUsdPerMillion: number;
  /** USD per million output tokens. */
  outputUsdPerMillion: number;
  /** USD per million cached input tokens. */
  cachedUsdPerMillion?: number;
}

export interface CostMetrics {
  totalTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cachedCostUsd: number;
  totalCostUsd: number;
}

export interface InspectorState {
  connection: ConnectionStatus;
  run: RunInfo;
  agentified: AgentifiedInteractions;
  tokens: TokenState;
  streaming: StreamingMetrics;
  toolCalls: ToolCallDetail[];
  events: EventLogEntry[];
  messages: import("@ag-ui/client").Message[];
  isLoading: boolean;
  error: string | null;
  frontendTools: string[];
  sharedContext?: SharedContext;
  skills: SkillsState;
  cost: CostMetrics;
}

// Client types

export type StateListener = (state: InspectorState) => void;

export interface Subscription {
  unsubscribe: () => void;
}

// Agentified CUSTOM event helpers

export function isAgentifiedEvent(event: BaseEvent): event is CustomEvent {
  return (
    event.type === "CUSTOM" &&
    typeof (event as CustomEvent).name === "string" &&
    (event as CustomEvent).name.startsWith("agentified:")
  );
}
