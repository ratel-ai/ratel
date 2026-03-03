import { useContext } from "react";
import { AgentifiedContext } from "./provider.js";
import type { AgentifiedContextValue } from "./provider.js";

export function useAgentified(): AgentifiedContextValue {
  const ctx = useContext(AgentifiedContext);
  if (!ctx) {
    throw new Error("useAgentified must be used within <AgentifiedProvider>");
  }
  return ctx;
}
