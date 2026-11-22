"use client";

import { Select } from "@ratel/design-system/select";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { EnvironmentSelect, WindowControl } from "@/components/console/agents/EntityFilters";
import { MCP_SERVER_PARAM } from "@/lib/views/mcp-servers/paths";
import type { ClientsFilterState } from "./ClientsView";

/** "All servers": an option value no real server key uses. */
const ALL = "__all__";

/**
 * The Clients tab's filters (RC-778): one MCP server, then the environment and
 * the time window of the servers list. All three live in the URL. The environment
 * and the window are the core's entity controls (the approved RP-25 design), in
 * place of upstream's McpServersFilters.
 */
export function ClientsFilters({
  servers,
  server,
  environments,
  environment,
  range,
}: ClientsFilterState) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // A filtered server the window no longer has stays selectable, so the reader can see and clear it.
  const values = server && !servers.includes(server) ? [...servers, server] : servers;

  function setServer(next: string) {
    const query = new URLSearchParams(params.toString());
    if (next === ALL) query.delete(MCP_SERVER_PARAM);
    else query.set(MCP_SERVER_PARAM, next);
    router.push(`${pathname}?${query.toString()}`);
  }

  return (
    <>
      {values.length > 0 ? (
        <Select
          aria-label="MCP server"
          className="w-auto"
          value={server ?? ALL}
          onValueChange={setServer}
          options={[
            { value: ALL, label: "All servers" },
            ...values.map((value) => ({ value, label: value })),
          ]}
        />
      ) : null}
      <EnvironmentSelect filters={{ environments, environment, range }} />
      <WindowControl filters={{ environments, environment, range }} />
    </>
  );
}
