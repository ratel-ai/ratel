interface ToolDefinition {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
interface ServerToolFields {
    name: string;
    description: string;
    input_schema?: string;
    output_schema?: string;
}
interface ServerTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    fields?: ServerToolFields;
}
interface RegisterRequest {
    tools: ServerTool[];
}
interface RegisterResponse {
    registered: number;
}
interface DiscoverRequest {
    query: string;
    limit?: number;
}
interface RankedTool extends ServerTool {
    score: number;
}
interface DiscoverResponse {
    tools: RankedTool[];
}
interface AgentifiedConfig {
    serverUrl: string;
}
interface Message {
    role: string;
    content: string;
}
interface PrefetchOptions {
    messages: Message[];
    topK?: number;
}
interface DiscoverToolInput {
    query?: string;
    queries?: string[];
}
interface DiscoverTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (input: DiscoverToolInput) => Promise<RankedTool[]>;
}

declare class Agentified {
    private serverUrl;
    constructor(config: AgentifiedConfig);
    register(tools: ToolDefinition[]): Promise<RegisterResponse>;
    prefetch(options: PrefetchOptions): Promise<DiscoverResponse>;
    asDiscoverTool(options?: {
        topK?: number;
    }): DiscoverTool;
    private discover;
}

declare function tool(definition: ToolDefinition): ToolDefinition;

export { Agentified, type AgentifiedConfig, type DiscoverRequest, type DiscoverResponse, type DiscoverTool, type DiscoverToolInput, type Message, type PrefetchOptions, type RankedTool, type RegisterRequest, type RegisterResponse, type ServerTool, type ServerToolFields, type ToolDefinition, tool };
