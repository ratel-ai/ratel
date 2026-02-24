import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { Inspector } from "../inspector.js";
import type { InspectorState } from "@agentified/fe-client";
import { AgentifiedContext } from "../provider.js";
import type { AgentifiedContextValue } from "../provider.js";

function createInitialState(overrides?: Partial<InspectorState>): InspectorState {
  return {
    connection: "idle",
    run: {},
    agentified: { prefetchResults: [], discoveries: [], currentTools: [] },
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    streaming: { messageCount: 0, toolCallCount: 0 },
    toolCalls: [],
    events: [],
    messages: [],
    isLoading: false,
    error: null,
    ...overrides,
  };
}

function renderInspector(
  state: InspectorState,
  props?: { defaultOpen?: boolean },
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
    it("renders trigger button when closed", () => {
      renderInspector(createInitialState());
      expect(screen.getByTestId("inspector-toggle")).toBeTruthy();
      expect(screen.queryByTestId("inspector-panel")).toBeNull();
    });

    it("trigger is fixed bottom-center", () => {
      renderInspector(createInitialState());
      const trigger = screen.getByTestId("inspector-toggle");
      expect(trigger.style.bottom).toBe("16px");
      expect(trigger.style.left).toBe("50%");
    });

    it("opens modal when trigger clicked", () => {
      renderInspector(createInitialState());
      fireEvent.click(screen.getByTestId("inspector-toggle"));
      expect(screen.getByTestId("inspector-panel")).toBeTruthy();
      expect(screen.getByTestId("inspector-overlay")).toBeTruthy();
    });

    it("closes modal when close button clicked", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      fireEvent.click(screen.getByTestId("inspector-close"));
      expect(screen.queryByTestId("inspector-panel")).toBeNull();
    });

    it("closes modal when overlay clicked", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      fireEvent.click(screen.getByTestId("inspector-overlay"));
      expect(screen.queryByTestId("inspector-panel")).toBeNull();
    });

    it("respects defaultOpen prop", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      expect(screen.getByTestId("inspector-panel")).toBeTruthy();
    });
  });

  describe("tabs", () => {
    it("shows 3 tabs: Timeline, Learning, Data", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      expect(screen.getByTestId("tab-timeline")).toBeTruthy();
      expect(screen.getByTestId("tab-learning")).toBeTruthy();
      expect(screen.getByTestId("tab-data")).toBeTruthy();
    });

    it("defaults to Timeline tab", () => {
      renderInspector(createInitialState({
        connection: "connected",
        run: { runId: "r1" },
      }), { defaultOpen: true });
      // Timeline tab content is visible — shows Run section with status
      expect(screen.getByText("Connected")).toBeTruthy();
    });
  });

  describe("Timeline tab", () => {
    it("shows run status metrics", () => {
      renderInspector(
        createInitialState({
          connection: "connected",
          run: { runId: "r1", durationMs: 3400 },
          streaming: { messageCount: 5, toolCallCount: 2, timeToFirstTokenMs: 120 },
        }),
        { defaultOpen: true },
      );

      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText("r1")).toBeTruthy();
      expect(screen.getAllByText("3400ms").length).toBeGreaterThanOrEqual(1);
    });

    it("shows interaction timeline entries", () => {
      renderInspector(
        createInitialState({
          events: [
            { timestamp: Date.now(), event: { type: "RUN_STARTED", runId: "r1" } as any, isAgentified: false },
            { timestamp: Date.now(), event: { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "search" } as any, isAgentified: false },
          ],
          toolCalls: [{ id: "tc1", name: "search", args: '{"q":"test"}', startedAt: Date.now(), endedAt: Date.now() + 100, durationMs: 100 }],
        }),
        { defaultOpen: true },
      );

      const items = screen.getAllByTestId("timeline-item");
      expect(items.length).toBeGreaterThanOrEqual(2);
    });

    it("shows empty state when no events", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      expect(screen.getByText("No events yet")).toBeTruthy();
    });

    it("shows streaming metrics", () => {
      renderInspector(
        createInitialState({
          streaming: { messageCount: 3, toolCallCount: 1, timeToFirstTokenMs: 80 },
        }),
        { defaultOpen: true },
      );
      expect(screen.getByText("3")).toBeTruthy();
      expect(screen.getByText("1")).toBeTruthy();
    });
  });

  describe("Learning tab", () => {
    it("shows current tools with score bars", () => {
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
      fireEvent.click(screen.getByTestId("tab-learning"));

      expect(screen.getByText("search_docs")).toBeTruthy();
      expect(screen.getByText("0.95")).toBeTruthy();
    });

    it("shows prefetch history", () => {
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
      fireEvent.click(screen.getByTestId("tab-learning"));

      expect(screen.getByText("200ms")).toBeTruthy();
      expect(screen.getByText("1 tools")).toBeTruthy();
    });

    it("shows discoveries", () => {
      renderInspector(
        createInitialState({
          agentified: {
            prefetchResults: [],
            discoveries: [
              { query: "find email tools", tools: [{ name: "a", description: "", score: 0.8 }], durationMs: 150 },
            ],
            currentTools: [],
          },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-learning"));

      expect(screen.getByText('"find email tools"')).toBeTruthy();
      expect(screen.getByText("1 tools · 150ms")).toBeTruthy();
    });

    it("shows empty state when no interactions", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-learning"));

      expect(screen.getByText("No Agentified interactions yet")).toBeTruthy();
    });
  });

  describe("Data tab", () => {
    it("shows session summary grid", () => {
      renderInspector(
        createInitialState({
          streaming: { messageCount: 5, toolCallCount: 2 },
          events: [
            { timestamp: Date.now(), event: { type: "RUN_STARTED" } as any, isAgentified: false },
          ],
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-data"));

      const cells = screen.getAllByTestId("stat-cell");
      expect(cells.length).toBeGreaterThanOrEqual(3);
    });

    it("shows token breakdown when tokens present", () => {
      renderInspector(
        createInitialState({
          tokens: { input: 1500, output: 300, cached: 200, reasoning: 0 },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-data"));

      expect(screen.getByText("1.5k")).toBeTruthy();
      expect(screen.getByText("300")).toBeTruthy();
    });

    it("shows context window bar when available", () => {
      renderInspector(
        createInitialState({
          tokens: { input: 0, output: 0, cached: 0, reasoning: 0, contextWindowPercent: 42.5 },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-data"));

      expect(screen.getByTestId("context-bar")).toBeTruthy();
      expect(screen.getByText("Context: 42.5%")).toBeTruthy();
    });

    it("renders event log with entries", () => {
      renderInspector(
        createInitialState({
          events: [
            { timestamp: Date.now(), event: { type: "RUN_STARTED" } as any, isAgentified: false },
            { timestamp: Date.now(), event: { type: "CUSTOM", name: "agentified:prefetch:complete" } as any, isAgentified: true },
          ],
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-data"));

      const rows = screen.getAllByTestId("event-row");
      expect(rows).toHaveLength(2);
      expect(screen.getByText("RUN_STARTED")).toBeTruthy();
      expect(screen.getByText("agentified:prefetch:complete")).toBeTruthy();
    });

    it("shows empty event log state", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-data"));

      expect(screen.getByText("No events")).toBeTruthy();
    });

    it("filter buttons filter events", () => {
      renderInspector(
        createInitialState({
          events: [
            { timestamp: Date.now(), event: { type: "RUN_STARTED" } as any, isAgentified: false },
            { timestamp: Date.now(), event: { type: "CUSTOM", name: "agentified:prefetch:complete" } as any, isAgentified: true },
            { timestamp: Date.now(), event: { type: "TOOL_CALL_START", toolCallId: "tc1" } as any, isAgentified: false },
          ],
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-data"));

      // Default: all
      expect(screen.getAllByTestId("event-row")).toHaveLength(3);

      // Filter: agentified
      fireEvent.click(screen.getByTestId("filter-agentified"));
      expect(screen.getAllByTestId("event-row")).toHaveLength(1);

      // Filter: tool_calls
      fireEvent.click(screen.getByTestId("filter-tool_calls"));
      expect(screen.getAllByTestId("event-row")).toHaveLength(1);

      // Back to all
      fireEvent.click(screen.getByTestId("filter-all"));
      expect(screen.getAllByTestId("event-row")).toHaveLength(3);
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
