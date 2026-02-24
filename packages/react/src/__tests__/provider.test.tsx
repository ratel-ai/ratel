import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { AgentifiedProvider } from "../provider.js";
import { useAgentified } from "../hook.js";
import type { AgentifiedClient, InspectorState, StateListener, Subscription } from "@agentified/fe-client";

function createMockClient(initial?: Partial<InspectorState>): AgentifiedClient & { emit: (s: InspectorState) => void } {
  const listeners = new Set<StateListener>();
  const state: InspectorState = {
    connection: "idle",
    run: {},
    agentified: { prefetchResults: [], discoveries: [], currentTools: [] },
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    streaming: { messageCount: 0, toolCallCount: 0 },
    events: [],
    ...initial,
  };

  return {
    getState: () => state,
    subscribe: (listener: StateListener): Subscription => {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    reset: vi.fn(() => {
      Object.assign(state, {
        connection: "idle",
        run: {},
        agentified: { prefetchResults: [], discoveries: [], currentTools: [] },
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        streaming: { messageCount: 0, toolCallCount: 0 },
        events: [],
      });
      for (const l of listeners) l(state);
    }),
    emit(s: InspectorState) {
      for (const l of listeners) l(s);
    },
  } as unknown as AgentifiedClient & { emit: (s: InspectorState) => void };
}

function TestConsumer() {
  const { state } = useAgentified();
  return <div data-testid="connection">{state.connection}</div>;
}

afterEach(cleanup);

describe("AgentifiedProvider", () => {
  it("provides initial state to children", () => {
    const client = createMockClient();
    render(
      <AgentifiedProvider client={client}>
        <TestConsumer />
      </AgentifiedProvider>,
    );
    expect(screen.getByTestId("connection").textContent).toBe("idle");
  });

  it("updates children when state changes", () => {
    const client = createMockClient();
    render(
      <AgentifiedProvider client={client}>
        <TestConsumer />
      </AgentifiedProvider>,
    );

    act(() => {
      client.emit({ ...client.getState(), connection: "connected" });
    });

    expect(screen.getByTestId("connection").textContent).toBe("connected");
  });

  it("calls onRun when run is invoked", () => {
    const client = createMockClient();
    const onRun = vi.fn();
    let runFn: (input: { threadId?: string }) => void;

    function RunConsumer() {
      const { run } = useAgentified();
      runFn = run;
      return null;
    }

    render(
      <AgentifiedProvider client={client} onRun={onRun}>
        <RunConsumer />
      </AgentifiedProvider>,
    );

    act(() => {
      runFn!({ threadId: "t1" });
    });

    expect(onRun).toHaveBeenCalledWith({ threadId: "t1" });
  });

  it("calls client.reset when reset is invoked", () => {
    const client = createMockClient();
    let resetFn: () => void;

    function ResetConsumer() {
      const { reset } = useAgentified();
      resetFn = reset;
      return null;
    }

    render(
      <AgentifiedProvider client={client}>
        <ResetConsumer />
      </AgentifiedProvider>,
    );

    act(() => {
      resetFn!();
    });

    expect(client.reset).toHaveBeenCalled();
  });

  it("unsubscribes on unmount", () => {
    const client = createMockClient();
    const { unmount } = render(
      <AgentifiedProvider client={client}>
        <TestConsumer />
      </AgentifiedProvider>,
    );

    unmount();

    // Should not throw after unmount
    act(() => {
      client.emit({ ...client.getState(), connection: "error" });
    });
  });
});

describe("useAgentified", () => {
  it("throws when used outside provider", () => {
    // Suppress React error boundary console noise
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => render(<TestConsumer />)).toThrow(
      "useAgentified must be used within <AgentifiedProvider>",
    );

    spy.mockRestore();
  });
});
