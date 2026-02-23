import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { AgentifiedProvider } from "../provider.js";
import { Inspector } from "../inspector.js";
import type {
  AgentifiedClient,
  InspectorState,
  StateListener,
  Subscription,
} from "@agentified/fe-client";

function createInitialState(overrides?: Partial<InspectorState>): InspectorState {
  return {
    connection: "idle",
    run: {},
    agentified: { prefetchResults: [], discoveries: [], currentTools: [] },
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    streaming: { messageCount: 0, toolCallCount: 0 },
    events: [],
    ...overrides,
  };
}

function createMockClient(
  initial?: Partial<InspectorState>,
): AgentifiedClient & { emit: (s: InspectorState) => void } {
  let state = createInitialState(initial);
  const listeners = new Set<StateListener>();

  return {
    getState: () => state,
    subscribe: (listener: StateListener): Subscription => {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    reset: vi.fn(),
    emit(s: InspectorState) {
      state = s;
      for (const l of listeners) l(s);
    },
  } as AgentifiedClient & { emit: (s: InspectorState) => void };
}

function renderInspector(
  client: AgentifiedClient,
  props?: { position?: "bottom-right" | "bottom-left"; defaultOpen?: boolean },
) {
  return render(
    <AgentifiedProvider client={client}>
      <Inspector {...props} />
    </AgentifiedProvider>,
  );
}

afterEach(cleanup);

describe("Inspector", () => {
  describe("toggle", () => {
    it("renders toggle button when closed", () => {
      const client = createMockClient();
      renderInspector(client);
      expect(screen.getByTestId("inspector-toggle")).toBeTruthy();
      expect(screen.queryByTestId("inspector-panel")).toBeNull();
    });

    it("opens panel when toggle clicked", () => {
      const client = createMockClient();
      renderInspector(client);
      fireEvent.click(screen.getByTestId("inspector-toggle"));
      expect(screen.getByTestId("inspector-panel")).toBeTruthy();
    });

    it("closes panel when close button clicked", () => {
      const client = createMockClient();
      renderInspector(client, { defaultOpen: true });
      fireEvent.click(screen.getByTestId("inspector-close"));
      expect(screen.queryByTestId("inspector-panel")).toBeNull();
      expect(screen.getByTestId("inspector-toggle")).toBeTruthy();
    });

    it("respects defaultOpen prop", () => {
      const client = createMockClient();
      renderInspector(client, { defaultOpen: true });
      expect(screen.getByTestId("inspector-panel")).toBeTruthy();
    });
  });

  describe("Overview tab", () => {
    it("shows connection status and streaming metrics", () => {
      const client = createMockClient({
        connection: "connected",
        run: { runId: "r1", threadId: "t1" },
        streaming: { messageCount: 5, toolCallCount: 2, timeToFirstTokenMs: 120 },
      });
      renderInspector(client, { defaultOpen: true });

      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText("r1")).toBeTruthy();
      expect(screen.getByText("t1")).toBeTruthy();
      expect(screen.getByText("5")).toBeTruthy();
      expect(screen.getByText("2")).toBeTruthy();
      expect(screen.getByText("120ms")).toBeTruthy();
    });

    it("shows run duration when available", () => {
      const client = createMockClient({
        connection: "disconnected",
        run: { durationMs: 3400 },
      });
      renderInspector(client, { defaultOpen: true });
      expect(screen.getByText("3400ms")).toBeTruthy();
    });
  });

  describe("Agentified tab", () => {
    it("shows current tools", () => {
      const client = createMockClient({
        agentified: {
          prefetchResults: [],
          discoveries: [],
          currentTools: [
            { name: "search_docs", description: "Search documentation", score: 0.95 },
          ],
        },
      });
      renderInspector(client, { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-agentified"));

      expect(screen.getByText("search_docs")).toBeTruthy();
      expect(screen.getByText("score: 0.95")).toBeTruthy();
    });

    it("shows last prefetch result", () => {
      const client = createMockClient({
        agentified: {
          prefetchResults: [
            { tools: [{ name: "a", description: "", score: 0.5 }], durationMs: 200 },
          ],
          discoveries: [],
          currentTools: [],
        },
      });
      renderInspector(client, { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-agentified"));

      expect(screen.getByText("200ms")).toBeTruthy();
    });

    it("shows discoveries", () => {
      const client = createMockClient({
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
      });
      renderInspector(client, { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-agentified"));

      expect(screen.getByText('"find email tools"')).toBeTruthy();
      expect(screen.getByText("1 tools · 150ms")).toBeTruthy();
    });

    it("shows empty state when no interactions", () => {
      const client = createMockClient();
      renderInspector(client, { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-agentified"));

      expect(screen.getByText("No Agentified interactions yet")).toBeTruthy();
    });
  });

  describe("Tokens tab", () => {
    it("shows token breakdown and total", () => {
      const client = createMockClient({
        tokens: { input: 1500, output: 300, cached: 200, reasoning: 0 },
      });
      renderInspector(client, { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-tokens"));

      expect(screen.getByText("1.5k")).toBeTruthy();
      expect(screen.getByText("300")).toBeTruthy();
      expect(screen.getByText("200")).toBeTruthy();
      expect(screen.getByText("2.0k")).toBeTruthy(); // total
    });

    it("shows context window bar when available", () => {
      const client = createMockClient({
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0, contextWindowPercent: 42.5 },
      });
      renderInspector(client, { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-tokens"));

      expect(screen.getByTestId("context-bar")).toBeTruthy();
      expect(screen.getByText("42.5%")).toBeTruthy();
    });
  });

  describe("Events tab", () => {
    it("renders event log entries", () => {
      const client = createMockClient({
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
      });
      renderInspector(client, { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-events"));

      const rows = screen.getAllByTestId("event-row");
      expect(rows).toHaveLength(2);
      expect(screen.getByText("RUN_STARTED")).toBeTruthy();
      expect(screen.getByText("agentified:prefetch:complete")).toBeTruthy();
    });

    it("shows empty state when no events", () => {
      const client = createMockClient();
      renderInspector(client, { defaultOpen: true });
      fireEvent.click(screen.getByTestId("tab-events"));

      expect(screen.getByText("No events yet")).toBeTruthy();
    });
  });

  describe("position", () => {
    it("applies bottom-left positioning", () => {
      const client = createMockClient();
      renderInspector(client, { position: "bottom-left" });
      const toggle = screen.getByTestId("inspector-toggle");
      expect(toggle.style.left).toBe("16px");
      expect(toggle.style.bottom).toBe("16px");
    });
  });

  describe("live updates", () => {
    it("re-renders when state changes", () => {
      const client = createMockClient({ connection: "idle" });
      renderInspector(client, { defaultOpen: true });
      expect(screen.getByText("Idle")).toBeTruthy();

      act(() => {
        client.emit(createInitialState({ connection: "connected" }));
      });

      expect(screen.getByText("Connected")).toBeTruthy();
    });
  });
});
