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
    frontendTools: [],
    skills: { registered: [], activations: [], suggestions: [], reliability: [] },
    cost: { totalTokens: 0, inputCostUsd: 0, outputCostUsd: 0, cachedCostUsd: 0, totalCostUsd: 0 },
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

    it("opens panel when trigger clicked", () => {
      renderInspector(createInitialState());
      fireEvent.click(screen.getByTestId("inspector-toggle"));
      expect(screen.getByTestId("inspector-panel")).toBeTruthy();
      expect(screen.queryByTestId("inspector-overlay")).toBeNull();
    });

    it("closes panel when close button clicked", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      fireEvent.click(screen.getByTestId("inspector-close"));
      expect(screen.queryByTestId("inspector-panel")).toBeNull();
    });

    it("panel has position styles", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      const panel = screen.getByTestId("inspector-panel");
      expect(panel.style.position).toBe("fixed");
      expect(panel.style.width).toBeTruthy();
      expect(panel.style.height).toBeTruthy();
    });

    it("resize handle renders", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      expect(screen.getByTestId("inspector-resize")).toBeTruthy();
    });

    it("respects defaultOpen prop", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      expect(screen.getByTestId("inspector-panel")).toBeTruthy();
    });
  });

  describe("tabs", () => {
    it("shows 4 tabs: Timeline, Skills, Session, Log", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      expect(screen.getByTestId("tab-timeline")).toBeTruthy();
      expect(screen.getByTestId("tab-skills")).toBeTruthy();
      expect(screen.getByTestId("tab-session")).toBeTruthy();
      expect(screen.getByTestId("tab-log")).toBeTruthy();
    });

    it("defaults to Timeline tab", () => {
      renderInspector(createInitialState({
        connection: "connected",
        run: { runId: "r1" },
      }), { defaultOpen: true });
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

    it("shows TTFT metric when available", () => {
      renderInspector(
        createInitialState({
          streaming: { messageCount: 3, toolCallCount: 1, timeToFirstTokenMs: 80 },
        }),
        { defaultOpen: true },
      );
      expect(screen.getByText("80ms")).toBeTruthy();
    });

    it("shows frontend tools badges", () => {
      renderInspector(
        createInitialState({
          frontendTools: ["navigate_to_page", "get_page_snapshot"],
        }),
        { defaultOpen: true },
      );
      expect(screen.getByText("navigate_to_page")).toBeTruthy();
      expect(screen.getByText("get_page_snapshot")).toBeTruthy();
    });

    it("shows shared context", () => {
      renderInspector(
        createInitialState({
          sharedContext: { page: "employees", openModals: ["employeeModal"], activeTab: undefined },
        }),
        { defaultOpen: true },
      );
      expect(screen.getByText("employees")).toBeTruthy();
      expect(screen.getByText("employeeModal")).toBeTruthy();
    });
  });

  describe("Session tab", () => {
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
      fireEvent.click(screen.getByTestId("tab-session"));

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
      fireEvent.click(screen.getByTestId("tab-session"));

      expect(screen.getByText("1.5k")).toBeTruthy();
      expect(screen.getByText("300")).toBeTruthy();
    });

    it("shows context window bar when available", () => {
      renderInspector(
        createInitialState({
          tokens: { input: 100, output: 50, cached: 0, reasoning: 0, contextWindowPercent: 42.5 },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-session"));

      expect(screen.getByTestId("context-bar")).toBeTruthy();
      expect(screen.getByText("Context: 42.5%")).toBeTruthy();
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
      fireEvent.click(screen.getByTestId("tab-session"));

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
      fireEvent.click(screen.getByTestId("tab-session"));

      expect(screen.getByText('"find email tools"')).toBeTruthy();
      expect(screen.getByText("1 tools · 150ms")).toBeTruthy();
    });
  });

  describe("Log tab", () => {
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
      fireEvent.click(screen.getByTestId("tab-log"));

      const rows = screen.getAllByTestId("event-row");
      expect(rows).toHaveLength(2);
      expect(screen.getByText("RUN_STARTED")).toBeTruthy();
      expect(screen.getByText("agentified:prefetch:complete")).toBeTruthy();
    });

    it("shows empty event log state", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-log"));

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
      fireEvent.click(screen.getByTestId("tab-log"));

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

  describe("Inspector v2: hierarchical timeline", () => {
    it("groups consecutive tool calls under a skill activation", () => {
      const now = Date.now();
      renderInspector(
        createInitialState({
          events: [
            { timestamp: now, event: { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "draft_email" } as any, isAgentified: false },
            { timestamp: now + 1, event: { type: "TOOL_CALL_START", toolCallId: "tc2", toolCallName: "send_email" } as any, isAgentified: false },
          ],
          toolCalls: [
            { id: "tc1", name: "draft_email", args: "", startedAt: now, endedAt: now + 5, durationMs: 5 },
            { id: "tc2", name: "send_email", args: "", startedAt: now + 1, endedAt: now + 6, durationMs: 5 },
          ],
          skills: {
            registered: [
              { name: "compose_email", description: "compose & send", atoms: ["draft_email", "send_email"] },
            ],
            activations: [
              { skillName: "compose_email", firstActivatedAt: now, toolCallIds: ["tc1", "tc2"], reasoning: "user asked to email Bob" },
            ],
            suggestions: [],
            reliability: [],
          },
        }),
        { defaultOpen: true },
      );

      expect(screen.getByTestId("skill-activation-group")).toBeTruthy();
      expect(screen.getByText(/Skill: compose_email · 2 atoms/)).toBeTruthy();
      // tool calls render as children
      const children = screen.getByTestId("skill-group-children");
      expect(children).toBeTruthy();
      expect(children.querySelectorAll("[data-testid='timeline-item']").length).toBe(2);
    });

    it("does not group tool calls that don't match a registered skill", () => {
      const now = Date.now();
      renderInspector(
        createInitialState({
          events: [
            { timestamp: now, event: { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "search" } as any, isAgentified: false },
          ],
          toolCalls: [{ id: "tc1", name: "search", args: "", startedAt: now }],
        }),
        { defaultOpen: true },
      );

      expect(screen.queryByTestId("skill-activation-group")).toBeNull();
      expect(screen.getAllByTestId("timeline-item").length).toBe(1);
    });
  });

  describe("Inspector v2: Skills tab", () => {
    it("renders activations with reasoning when expanded", () => {
      renderInspector(
        createInitialState({
          skills: {
            registered: [
              { name: "compose_email", description: "compose & send", atoms: ["draft_email", "send_email"] },
            ],
            activations: [
              { skillName: "compose_email", firstActivatedAt: Date.now(), toolCallIds: ["tc1"], reasoning: "user asked to email Bob" },
            ],
            suggestions: [],
            reliability: [],
          },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-skills"));

      const activations = screen.getAllByTestId("skill-activation");
      expect(activations.length).toBe(1);
      expect(screen.getByText("compose_email")).toBeTruthy();

      // expand to see reasoning
      fireEvent.click(activations[0]!.querySelector("[role], div")! as HTMLElement);
      expect(screen.getByTestId("skill-reasoning").textContent).toContain("user asked to email Bob");
    });

    it("shows registered skills that didn't fire as inactive", () => {
      renderInspector(
        createInitialState({
          skills: {
            registered: [
              { name: "skill_a", description: "", atoms: ["x"] },
              { name: "skill_b", description: "", atoms: ["y"] },
            ],
            activations: [
              { skillName: "skill_a", firstActivatedAt: Date.now(), toolCallIds: ["tc1"] },
            ],
            suggestions: [],
            reliability: [],
          },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-skills"));

      expect(screen.getByTestId("skill-inactive-list")).toBeTruthy();
      expect(screen.getByText("skill_b")).toBeTruthy();
    });

    it("renders skill suggestions with rationale", () => {
      renderInspector(
        createInitialState({
          skills: {
            registered: [],
            activations: [],
            suggestions: [
              { toolNames: ["search", "summarize"], cooccurrenceCount: 3, proposedName: "skill_search_summarize", rationale: "fired together 3x" },
            ],
            reliability: [],
          },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-skills"));

      const suggestions = screen.getAllByTestId("skill-suggestion");
      expect(suggestions.length).toBe(1);
      expect(screen.getByText("skill_search_summarize")).toBeTruthy();
      expect(screen.getByText(/fired together 3x/)).toBeTruthy();
      expect(screen.getByText("×3")).toBeTruthy();
    });

    it("renders reliability issues", () => {
      renderInspector(
        createInitialState({
          skills: {
            registered: [],
            activations: [],
            suggestions: [],
            reliability: [
              { toolName: "send_email", type: "failure", count: 2, lastSeen: Date.now(), detail: "smtp timed out" },
              { toolName: "search", type: "retry", count: 3, lastSeen: Date.now() },
            ],
          },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-skills"));

      const issues = screen.getAllByTestId("reliability-issue");
      expect(issues.length).toBe(2);
      expect(screen.getByText("send_email")).toBeTruthy();
      expect(screen.getByText("smtp timed out")).toBeTruthy();
      expect(screen.getByText("failure")).toBeTruthy();
      expect(screen.getByText("retry")).toBeTruthy();
    });

    it("shows empty states when no activations/suggestions/reliability", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-skills"));

      expect(screen.getByText("No skills activated yet")).toBeTruthy();
      expect(screen.getByText("No suggestions yet")).toBeTruthy();
      expect(screen.getByText("No reliability issues observed")).toBeTruthy();
    });
  });

  describe("Inspector v2: Cost panel", () => {
    it("renders estimated cost when tokens have been used", () => {
      renderInspector(
        createInitialState({
          tokens: { input: 1_000_000, output: 500_000, cached: 0, reasoning: 0 },
          cost: { totalTokens: 1_500_000, inputCostUsd: 3, outputCostUsd: 7.5, cachedCostUsd: 0, totalCostUsd: 10.5 },
        }),
        { defaultOpen: true },
      );
      fireEvent.click(screen.getByTestId("tab-session"));

      expect(screen.getByTestId("cost-panel")).toBeTruthy();
      expect(screen.getByTestId("cost-total").textContent).toBe("$10.50");
    });

    it("does not render cost panel when no tokens used", () => {
      renderInspector(createInitialState(), { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-session"));

      expect(screen.queryByTestId("cost-panel")).toBeNull();
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
