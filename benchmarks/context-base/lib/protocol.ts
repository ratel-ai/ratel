export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  script: string;
}

export interface SetupBody {
  tools: ToolDef[];
  config: {
    agentifiedEndpoint?: string;
    model: string;
    systemPrompt: string;
    maxSteps: number;
  };
}

export interface SetupResponse {
  ok: true;
}

export interface SendMessageBody {
  history: Array<{ role: string; content: string }>;
  seed: number;
  expectedTools?: string[];
  turnId?: string;
}

export interface SendMessageResponse {
  content: string;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }>;
  usage: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    outputReasoningTokens?: number;
  };
  durationMs: number;
  hydratedTools?: string[];
  turnId?: string;
  debug?: {
    systemPrompt: string;
    toolNames: string[];
    modelResponse: string;
    toolCallsMade: Array<{ name: string; args: Record<string, unknown> }>;
    agentifiedLog?: Array<{ phase: string; detail: Record<string, unknown> }>;
  };
}
