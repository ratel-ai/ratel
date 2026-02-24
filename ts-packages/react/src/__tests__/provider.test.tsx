import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AgentifiedProvider } from "../provider.js";
import { useAgentified } from "../hook.js";

function TestConsumer() {
  const { state, messages, isLoading, error } = useAgentified();
  return (
    <div>
      <span data-testid="connection">{state.connection}</span>
      <span data-testid="message-count">{messages.length}</span>
      <span data-testid="is-loading">{String(isLoading)}</span>
      <span data-testid="error">{error ?? "none"}</span>
    </div>
  );
}

afterEach(cleanup);

describe("AgentifiedProvider", () => {
  it("provides initial state to children", () => {
    render(
      <AgentifiedProvider agentUrl="http://localhost:9119">
        <TestConsumer />
      </AgentifiedProvider>,
    );
    expect(screen.getByTestId("connection").textContent).toBe("idle");
    expect(screen.getByTestId("message-count").textContent).toBe("0");
    expect(screen.getByTestId("is-loading").textContent).toBe("false");
    expect(screen.getByTestId("error").textContent).toBe("none");
  });

  it("exposes sendMessage function", () => {
    let sendFn: ((content: string) => Promise<void>) | undefined;
    function SendConsumer() {
      const { sendMessage } = useAgentified();
      sendFn = sendMessage;
      return null;
    }

    render(
      <AgentifiedProvider agentUrl="http://localhost:9119">
        <SendConsumer />
      </AgentifiedProvider>,
    );

    expect(sendFn).toBeTypeOf("function");
  });

  it("exposes reset function", () => {
    let resetFn: (() => void) | undefined;
    function ResetConsumer() {
      const { reset } = useAgentified();
      resetFn = reset;
      return null;
    }

    render(
      <AgentifiedProvider agentUrl="http://localhost:9119">
        <ResetConsumer />
      </AgentifiedProvider>,
    );

    expect(resetFn).toBeTypeOf("function");
  });
});

describe("useAgentified", () => {
  it("throws when used outside provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => render(<TestConsumer />)).toThrow(
      "useAgentified must be used within <AgentifiedProvider>",
    );

    spy.mockRestore();
  });
});
