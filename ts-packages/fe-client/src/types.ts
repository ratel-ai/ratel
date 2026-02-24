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
  tokenUsage?: TokenUsage;
}

export interface DiscoveryResult {
  query: string;
  tools: AgentifiedTool[];
  durationMs: number;
  tokenUsage?: TokenUsage;
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

export interface InspectorState {
  connection: ConnectionStatus;
  run: RunInfo;
  agentified: AgentifiedInteractions;
  tokens: TokenState;
  streaming: StreamingMetrics;
  events: EventLogEntry[];
  messages: import("@ag-ui/client").Message[];
  isLoading: boolean;
  error: string | null;
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
