import type { AbstractAgent, BaseEvent, CustomEvent, Message, Context } from "@ag-ui/client";
import { HttpAgent, EventType, randomUUID } from "@ag-ui/client";
import type { AgentifiedClientConfig, InspectorState, StateListener, Subscription } from "./types.js";
import { isAgentifiedEvent } from "./types.js";

export class AgentifiedClient {
  private state: InspectorState;
  private listeners: Set<StateListener> = new Set();
  private agent: AbstractAgent;
  private pendingMessages: Map<string, { role: "assistant" | "user"; content: string }> = new Map();

  constructor(config: AgentifiedClientConfig) {
    this.state = createInitialState();
    const factory = config._agentFactory ?? defaultAgentFactory;
    this.agent = factory(config.agentUrl, config.headers);
    this.agent.subscribe({
      onEvent: ({ event }) => this.handleEvent(event),
    });
  }

  getState(): InspectorState {
    return this.state;
  }

  getMessages(): Message[] {
    return this.state.messages;
  }

  subscribe(listener: StateListener): Subscription {
    this.listeners.add(listener);
    return { unsubscribe: () => this.listeners.delete(listener) };
  }

  async run(input: { messages: Message[]; context?: Context[] }): Promise<void> {
    this.state = { ...this.state, isLoading: true, error: null };
    this.notify();

    try {
      this.agent.setMessages(input.messages);
      await this.agent.runAgent(input.context ? { context: input.context } : undefined);
    } catch (err) {
      this.state = { ...this.state, error: (err as Error).message };
    } finally {
      this.state = { ...this.state, isLoading: false };
      this.notify();
    }
  }

  async sendMessage(content: string): Promise<void> {
    const userMessage: Message = { id: randomUUID(), role: "user", content };
    this.state = { ...this.state, messages: [...this.state.messages, userMessage] };
    this.notify();
    await this.run({ messages: this.state.messages });
  }

  reset(): void {
    this.agent.abortRun();
    this.pendingMessages.clear();
    this.state = createInitialState();
    this.notify();
  }

  private handleEvent(event: BaseEvent): void {
    this.processEvent(event);
    this.state = {
      ...this.state,
      events: [
        ...this.state.events,
        { timestamp: Date.now(), event, isAgentified: isAgentifiedEvent(event) },
      ],
    };
    this.notify();
  }

  private processEvent(event: BaseEvent): void {
    switch (event.type) {
      case EventType.RUN_STARTED: {
        const e = event as unknown as { runId: string; threadId?: string };
        this.state = {
          ...this.state,
          connection: "connected",
          run: { ...this.state.run, runId: e.runId, threadId: e.threadId, startedAt: Date.now() },
        };
        break;
      }
      case EventType.RUN_FINISHED:
        this.state = {
          ...this.state,
          connection: "disconnected",
          run: {
            ...this.state.run,
            durationMs: this.state.run.startedAt ? Date.now() - this.state.run.startedAt : 0,
          },
        };
        break;
      case EventType.RUN_ERROR:
        this.state = { ...this.state, connection: "error" };
        break;
      case EventType.TEXT_MESSAGE_START: {
        const e = event as unknown as { messageId: string; role?: string };
        const role = (e.role ?? "assistant") as "assistant" | "user";
        this.pendingMessages.set(e.messageId, { role, content: "" });
        const newMsg = { id: e.messageId, role, content: "" } as unknown as Message;
        this.state = {
          ...this.state,
          streaming: { ...this.state.streaming, messageCount: this.state.streaming.messageCount + 1 },
          messages: [...this.state.messages, newMsg],
        };
        break;
      }
      case EventType.TEXT_MESSAGE_CONTENT: {
        const e = event as unknown as { messageId: string; delta: string };
        const pending = this.pendingMessages.get(e.messageId);
        if (pending) {
          pending.content += e.delta;
          this.state = {
            ...this.state,
            messages: this.state.messages.map(m =>
              m.id === e.messageId 
                ? ({ ...m, content: pending.content } as unknown as Message)
                : m,
            ),
          };
        }
        if (this.state.streaming.timeToFirstTokenMs === undefined && this.state.run.startedAt) {
          this.state = {
            ...this.state,
            streaming: {
              ...this.state.streaming,
              timeToFirstTokenMs: Date.now() - this.state.run.startedAt,
            },
          };
        }
        break;
      }
      case EventType.TEXT_MESSAGE_END: {
        const e = event as unknown as { messageId: string };
        this.pendingMessages.delete(e.messageId);
        break;
      }
      case EventType.TOOL_CALL_START:
        this.state = {
          ...this.state,
          streaming: { ...this.state.streaming, toolCallCount: this.state.streaming.toolCallCount + 1 },
        };
        break;
      case EventType.CUSTOM:
        if (isAgentifiedEvent(event)) {
          this.handleAgentifiedEvent(event as CustomEvent);
        }
        break;
    }
  }

  private handleAgentifiedEvent(event: CustomEvent): void {
    const { name, value } = event;

    if (name === "agentified:prefetch:complete") {
      const { tools, durationMs, tokenUsage } = value;
      this.state = {
        ...this.state,
        agentified: {
          ...this.state.agentified,
          prefetchResults: [...this.state.agentified.prefetchResults, { tools, durationMs }],
          currentTools: tools,
        },
      };
      if (tokenUsage) {
        this.state = { ...this.state, tokens: { ...this.state.tokens, ...tokenUsage } };
      }
    } else if (name === "agentified:discover:complete") {
      const { tools, durationMs, query, tokenUsage } = value;
      this.state = {
        ...this.state,
        agentified: {
          ...this.state.agentified,
          discoveries: [...this.state.agentified.discoveries, { query, tools, durationMs }],
          currentTools: tools,
        },
      };
      if (tokenUsage) {
        this.state = { ...this.state, tokens: { ...this.state.tokens, ...tokenUsage } };
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

function defaultAgentFactory(url: string, headers?: Record<string, string>): AbstractAgent {
  return new HttpAgent({ url, headers: headers ?? {} });
}

function createInitialState(): InspectorState {
  return {
    connection: "idle",
    run: {},
    agentified: { prefetchResults: [], discoveries: [], currentTools: [] },
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    streaming: { messageCount: 0, toolCallCount: 0 },
    events: [],
    messages: [],
    isLoading: false,
    error: null,
  };
}
