import { useEffect } from "react";
import { useAgentifiedClient } from "./provider.js";

export function useAgentifiedTool(
  name: string,
  handler: (args: unknown) => Promise<unknown>,
): void {
  const client = useAgentifiedClient();
  useEffect(() => {
    client.registerToolHandler(name, handler);
    return () => client.unregisterToolHandler(name);
  }, [client, name, handler]);
}
