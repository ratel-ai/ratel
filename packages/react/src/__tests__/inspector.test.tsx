import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { AgentifiedProvider } from "../provider.js";
import { Inspector } from "../inspector.js";
import type { InspectorState } from "@agentified/fe-client";

function createInitialState(overrides?: Partial<InspectorState>): InspectorState {
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
    ...overrides,
  };
}

// For inspector tests we mock at the AgentifiedClient level since the provider
// creates its own client internally. We intercept via vi.mock.
// Actually, inspector uses useAgentified → AgentifiedContext. We need to provide context.
// The simplest approach: mock the module to intercept client creation.

// Instead, we'll use a thin wrapper that provides the context directly.
import { AgentifiedContext } from "../provider.js";
import type { AgentifiedContextValue } from "../provider.js";

function renderInspector(
  state: InspectorState,
  props?: { position?: "bottom-right" | "bottom-left"; defaultOpen?: boolean },
) {
  const contextValue: AgentifiedContextValue = {
    state,
    messages: state.messages,
    sendMessage: vi.fn(),
    isLoading: state.isLoading,
    error: state.error,
    reset: vi.fn(),
  };

  const result = render(
    <AgentifiedContext.Provider value={contextValue}>
      <Inspector {...props} />
    </AgentifiedContext.Provider>,
  );

  return {
    ...result,
    updateState: (newState: InspectorState) => {
      const newValue: AgentifiedContextValue = {
        state: newState,
        messages: newState.messages,
        sendMessage: vi.fn(),
        isLoading: newState.isLoading,
        error: newState.error,
        reset: vi.fn(),
      };
      result.rerender(
        <AgentifiedContext.Provider value={newValue}>
          <Inspector {...props} />
        </AgentifiedContext.Provider>,
      );
    },
  };
}

afterEach(cleanup);

describe("Inspector", () => {
  describe("toggle", () => {
    it("renders toggle button when closed", () => {
      renderInspector(createInitialState());
      expect(screen.getByTestId("inspector-toggle")).toBeTruthy();
      expect(screen.queryByTestId("inspector-panel")).toBeNull();
    });

    it("opens panel when toggle clicked", () => {
      renderInspector(createInitialState());
      fireEvent.click(screen.getByTestId("inspector-toggle"));
      expect(screen.getByTestId("inspector-panel")).toBeTruthy();
    });

    it("closes panel when close button clicked", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      fireEvent.click(screen.getByTestId("inspector-close"));
      expect(screen.queryByTestId("inspector-panel")).toBeNull();
      expect(screen.getByTestId("inspector-toggle")).toBeTruthy();
    });

    it("respects defaultOpen prop", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      expect(screen.getByTestId("inspector-panel")).toBeTruthy();
    });
  });

  describe("Overview tab", () => {
    it("shows connection status and streaming metrics", () => {
      renderInspector(
        createInitialState({
          connection: "connected",
          run: { runId: "r1", threadId: "t1" },
          streaming: { messageCount: 5, toolCallCount: 2, timeToFirstTokenMs: 120 },
        }),
        { defaultOpen: true },
      );

      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText("r1")).toBeTruthy();
      expect(screen.getByText("t1")).toBeTruthy();
      expect(screen.getByText("5")).toBeTruthy();
      expect(screen.getByText("2")).toBeTruthy();
      expect(screen.getByText("120ms")).toBeTruthy();
    });

    it("shows run duration when available", () => {
      renderInspector(
        createInitialState({
          connection: "disconnected",
          run: { durationMs: 3400 },
        }),
        { defaultOpen: true },
      );
      expect(screen.getByText("3400ms")).toBeTruthy();
    });
  });

  describe("Agentified tab", () => {
    it("shows current tools", () => {
      renderInspector(
        createInitialState({
          agentified: {
            prefetchResults: [],
            discoveries: [],
            currentTools: [
              { name: "search_docs", description: "Search documentation", score: 0.95 },
            ],
          },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-agentified"));

      expect(screen.getByText("search_docs")).toBeTruthy();
      expect(screen.getByText("score: 0.95")).toBeTruthy();
    });

    it("shows last prefetch result", () => {
      renderInspector(
        createInitialState({
          agentified: {
            prefetchResults: [
              { tools: [{ name: "a", description: "", score: 0.5 }], durationMs: 200 },
            ],
            discoveries: [],
            currentTools: [],
          },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-agentified"));

      expect(screen.getByText("200ms")).toBeTruthy();
    });

    it("shows discoveries", () => {
      renderInspector(
        createInitialState({
          agentified: {
            prefetchResults: [],
            discoveries: [
              {
                query: "find email tools",
                tools: [{ name: "a", description: "", score: 0.8 }],
                durationMs: 150,
              },
            ],
            currentTools: [],
          },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-agentified"));

      expect(screen.getByText('"find email tools"')).toBeTruthy();
      expect(screen.getByText("1 tools · 150ms")).toBeTruthy();
    });

    it("shows empty state when no interactions", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-agentified"));

      expect(screen.getByText("No Agentified interactions yet")).toBeTruthy();
    });
  });

  describe("Tokens tab", () => {
    it("shows token breakdown and total", () => {
      renderInspector(
        createInitialState({
          tokens: { input: 1500, output: 300, cached: 200, reasoning: 0 },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-tokens"));

      expect(screen.getByText("1.5k")).toBeTruthy();
      expect(screen.getByText("300")).toBeTruthy();
      expect(screen.getByText("200")).toBeTruthy();
      expect(screen.getByText("2.0k")).toBeTruthy(); // total
    });

    it("shows context window bar when available", () => {
      renderInspector(
        createInitialState({
          tokens: { input: 0, output: 0, cached: 0, reasoning: 0, contextWindowPercent: 42.5 },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-tokens"));

      expect(screen.getByTestId("context-bar")).toBeTruthy();
      expect(screen.getByText("42.5%")).toBeTruthy();
    });
  });

  describe("Events tab", () => {
    it("renders event log entries", () => {
      renderInspector(
        createInitialState({
          events: [
            {
              timestamp: Date.now(),
              event: { type: "RUN_STARTED" } as any,
              isAgentified: false,
            },
            {
              timestamp: Date.now(),
              event: { type: "CUSTOM", name: "agentified:prefetch:complete" } as any,
              isAgentified: true,
            },
          ],
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-events"));

      const rows = screen.getAllByTestId("event-row");
      expect(rows).toHaveLength(2);
      expect(screen.getByText("RUN_STARTED")).toBeTruthy();
      expect(screen.getByText("agentified:prefetch:complete")).toBeTruthy();
    });

    it("shows empty state when no events", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-events"));

      expect(screen.getByText("No events yet")).toBeTruthy();
    });
  });

  describe("position", () => {
    it("applies bottom-left positioning", () => {
      renderInspector(createInitialState(), { position: "bottom-left" });
      const toggle = screen.getByTestId("inspector-toggle");
      expect(toggle.style.left).toBe("16px");
      expect(toggle.style.bottom).toBe("16px");
    });
  });

  describe("live updates", () => {
    it("re-renders when state changes", () => {
      const { updateState } = renderInspector(
        createInitialState({ connection: "idle" }),
        { defaultOpen: true },
      );
      expect(screen.getByText("Idle")).toBeTruthy();

      act(() => {
        updateState(createInitialState({ connection: "connected" }));
      });

      expect(screen.getByText("Connected")).toBeTruthy();
    });
  });
});
