// Search strategy

export type SearchStrategy = "bm25" | "semantic" | "hybrid";

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
  alwaysInclude?: boolean;
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
  strategy?: SearchStrategy;
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
  strategy?: SearchStrategy;
}

export interface DiscoverTool {
  definition: ToolDefinition;
  execute: (input: DiscoverToolInput) => Promise<RankedTool[]>;
  /** Tool names found so far — populated by execute() */
  readonly discoveredNames: Set<string>;
}

export interface GetMessagesToolInput {
  limit?: number;
  afterSeq?: number;
  aroundSeq?: number;
}

export interface GetMessagesTool {
  definition: ToolDefinition;
  execute: (input: GetMessagesToolInput) => Promise<GetMessagesResponse>;
}

// Context strategy

export type ContextStrategy = "recent" | "full" | "compacted";

export type CompactionStrategy = (messages: StoredMessage[]) => Promise<{ summary: string }>;

// Recall types

export interface RecallToolsConfig {
  limit?: number;
  minSimilarity?: number;
}

export interface RecallConfig {
  tools?: boolean | RecallToolsConfig;
}

// Message persistence types

export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: unknown;
  createdAt: string;
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
  strategy?: ContextStrategy;
  maxTokens?: number;
  recall?: RecallConfig;
  limitTokens?: number;
  keepFirst?: boolean;
  pruneThreshold?: number;
  compactionStrategy?: CompactionStrategy;
}

export interface SummaryRange {
  firstSeq: number;
  lastSeq: number;
  count: number;
}

export interface ContextResponse {
  messages: StoredMessage[];
  strategyUsed: ContextStrategy;
  totalMessages: number;
  includedMessages: number;
  recalled: { tools: RankedTool[]; memories: unknown[] };
  tokenEstimate: number;
  conversationMessages: number;
  fallback: boolean;
  summary?: string;
  summaryRange?: SummaryRange;
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
  headers?: Record<string, string>;
  onEvent?: (event: AgentifiedEvent) => void;
  strategy?: SearchStrategy;
}

// High-level SDK types

export interface BackendTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  type?: "backend";
  alwaysInclude?: boolean;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ClientTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  type: "client";
}

export interface McpTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  type: "mcp";
  server: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export type AgentifiedTool = BackendTool | ClientTool | McpTool;

export type PrepareStepFn = (params: {
  stepNumber: number;
  steps: any[];
}) => Promise<{ activeTools: string[] }>;

export interface AssembledContext<T = AgentifiedTool> {
  messages: StoredMessage[];
  recalled: { tools: RankedTool[]; memories: unknown[] };
  strategyUsed: ContextStrategy;
  fallback: boolean;
  tokenEstimate: number;
  conversationMessages: number;
  totalMessages: number;
  includedMessages: number;
  tools: Record<string, T>;
  summary?: string;
  summaryRange?: SummaryRange;
}

export interface GetMessagesOptions {
  maxMessages?: number;
  maxTokens?: number;
  strategy?: ContextStrategy;
}

export interface GetMessagesResult {
  messages: StoredMessage[];
  totalMessages: number;
  includedMessages: number;
  strategyUsed: ContextStrategy;
  fallback: boolean;
}

export interface RegisterInput {
  tools: AgentifiedTool[];
}
