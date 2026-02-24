import { createContext, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AgentifiedClient } from "@agentified/fe-client";
import type { InspectorState, Message } from "@agentified/fe-client";

export interface AgentifiedContextValue {
  state: InspectorState;
  messages: Message[];
  sendMessage: (content: string) => Promise<void>;
  isLoading: boolean;
  error: string | null;
  reset: () => void;
}

export const AgentifiedContext = createContext<AgentifiedContextValue | null>(null);

export interface AgentifiedProviderProps {
  agentUrl: string;
  headers?: Record<string, string>;
  children: ReactNode;
}

export function AgentifiedProvider({ agentUrl, headers, children }: AgentifiedProviderProps) {
  const client = useMemo(
    () => new AgentifiedClient({ agentUrl, headers }),
    [agentUrl, headers],
  );

  const [state, setState] = useState<InspectorState>(() => client.getState());

  useEffect(() => {
    setState(client.getState());
    const sub = client.subscribe((next) => setState(next));
    return () => sub.unsubscribe();
  }, [client]);

  const sendMessage = useCallback(
    (content: string) => client.sendMessage(content),
    [client],
  );

  const reset = useCallback(() => {
    client.reset();
  }, [client]);

  const value = useMemo<AgentifiedContextValue>(
    () => ({
      state,
      messages: state.messages,
      sendMessage,
      isLoading: state.isLoading,
      error: state.error,
      reset,
    }),
    [state, sendMessage, reset],
  );

  return <AgentifiedContext.Provider value={value}>{children}</AgentifiedContext.Provider>;
}
