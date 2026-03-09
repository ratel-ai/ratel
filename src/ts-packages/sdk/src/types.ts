// Server types (mirror Rust models)

export interface ServerToolFields {
  name: string;
  description: string;
  inputSchema?: string;
  outputSchema?: string;
}

export interface ServerTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  fields?: ServerToolFields;
}

export interface RankedTool extends ServerTool {
  score: number;
  graphExpanded?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// API types

export interface RegisterRequest {
  tools: ServerTool[];
}

export interface RegisterResponse {
  registered: number;
}

export interface DiscoverResponse {
  tools: RankedTool[];
}

export interface Message {
  role: string;
  content: string;
}

export interface PrefetchOptions {
  messages: Message[];
  limit?: number;
  exclude?: string[];
  turnId?: string;
}

export interface CaptureTurnOptions {
  toolsLoaded: string[];
  message: string;
}

export interface CaptureTurnResponse {
  turnId: string;
}

export interface DiscoverToolInput {
  query: string;
  limit?: number;
}

export interface DiscoverTool {
  definition: ToolDefinition;
  execute: (input: DiscoverToolInput) => Promise<RankedTool[]>;
}

// Message persistence types

export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown;
  created_at: string;
  seq: number;
}

export interface AppendMessagesResponse {
  appended: number;
  firstSeq: number;
  lastSeq: number;
}

export interface GetMessagesOpts {
  limit?: number;
  afterSeq?: number;
  aroundSeq?: number;
}

export interface GetMessagesResponse {
  messages: StoredMessage[];
  hasMore: boolean;
  maxSeq: number;
}

export interface ContextOpts {
  strategy?: string;
  maxTokens?: number;
}

export interface ContextResponse {
  messages: StoredMessage[];
  strategyUsed: string;
  totalMessages: number;
  includedMessages: number;
  recalled: { tools: unknown[]; memories: unknown[] };
  tokenEstimate: number;
  conversationMessages: number;
  fallback: boolean;
}

// Event types

export interface TokenUsage {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
}

export type AgentifiedEvent =
  | { type: "agentified:prefetch:start"; messages: Message[] }
  | {
      type: "agentified:prefetch:complete";
      tools: RankedTool[];
      durationMs: number;
      tokenUsage?: TokenUsage;
    }
  | {
      type: "agentified:prefetch:skipped";
      tools: RankedTool[];
      durationMs: number;
    }
  | { type: "agentified:discover:start"; query: string }
  | {
      type: "agentified:discover:complete";
      query: string;
      tools: RankedTool[];
      durationMs: number;
      tokenUsage?: TokenUsage;
    };

// Config

export interface ApiClientConfig {
  serverUrl: string;
  tools: ServerTool[];
  onEvent?: (event: AgentifiedEvent) => void;
}
