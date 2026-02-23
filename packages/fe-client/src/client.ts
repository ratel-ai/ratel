import type { AbstractAgent, BaseEvent, CustomEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import type { InspectorState, StateListener, Subscription } from "./types.js";
import { isAgentifiedEvent } from "./types.js";

export class AgentifiedClient {
  private state: InspectorState;
  private listeners: Set<StateListener> = new Set();

  constructor(agent: AbstractAgent) {
    this.state = createInitialState();
    agent.subscribe({
      onEvent: ({ event }) => this.handleEvent(event),
    });
  }

  getState(): InspectorState {
    return this.state;
  }

  subscribe(listener: StateListener): Subscription {
    this.listeners.add(listener);
    return { unsubscribe: () => this.listeners.delete(listener) };
  }

  reset(): void {
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
        const e = event as { runId: string; threadId?: string };
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
      case EventType.TEXT_MESSAGE_START:
        this.state = {
          ...this.state,
          streaming: { ...this.state.streaming, messageCount: this.state.streaming.messageCount + 1 },
        };
        break;
      case EventType.TEXT_MESSAGE_CONTENT:
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

function createInitialState(): InspectorState {
  return {
    connection: "idle",
    run: {},
    agentified: { prefetchResults: [], discoveries: [], currentTools: [] },
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    streaming: { messageCount: 0, toolCallCount: 0 },
    events: [],
  };
}
