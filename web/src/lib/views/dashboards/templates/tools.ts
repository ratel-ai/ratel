import type { DashboardTemplate } from "@/lib/views/dashboards/templates/types";
import { rqlTemplateWidget, WIDE } from "@/lib/views/dashboards/templates/widgets";

/** The tool name of a tool call: its gen_ai attribute, else the span's name. */
const TOOL = "coalesce(attributes['gen_ai.tool.name'], name)";
const TOOL_CALLS = "from events\nwhere type = 'tool_call'";

export const TOOLS_TEMPLATE: DashboardTemplate = {
  id: "tools",
  name: "Tools",
  description: "Calls, errors and latency of each tool, and the tool calls that failed.",
  prompt: "Show how my agents use their tools: calls, errors and the slowest tools",
  needs: ["tool_calls"],
  property: false,
  widgets: [
    rqlTemplateWidget(
      "Calls per tool",
      "bar",
      `select ${TOOL} as tool, count(*) as calls\n${TOOL_CALLS}\ngroup by tool\norder by calls desc\nlimit 20`,
    ),
    rqlTemplateWidget(
      "Error rate per tool",
      "bar",
      `select ${TOOL} as tool, rate(status = 'error') as error_rate\n${TOOL_CALLS}\ngroup by tool\norder by error_rate desc\nlimit 20`,
    ),
    rqlTemplateWidget(
      "Slowest tools (p95)",
      "bar",
      `select ${TOOL} as tool, p95(duration_ms) as p95_ms\n${TOOL_CALLS}\ngroup by tool\norder by p95_ms desc\nlimit 20`,
    ),
    rqlTemplateWidget(
      "Tool calls per day",
      "line",
      `select time_bucket('1 day', started_at) as day, count(*) as calls\n${TOOL_CALLS}\ngroup by day\norder by day desc`,
    ),
    rqlTemplateWidget(
      "Calls by MCP server",
      "bar",
      `select mcp_server, count(*) as calls\n${TOOL_CALLS}\n  and mcp_server is not null\ngroup by mcp_server\norder by calls desc\nlimit 20`,
    ),
    rqlTemplateWidget(
      "Tool calls per trace",
      "table",
      `select trace_id, count(*) as tool_calls\n${TOOL_CALLS}\ngroup by trace_id\norder by tool_calls desc\nlimit 20`,
    ),
    rqlTemplateWidget(
      "Tool calls that failed",
      "table",
      `select started_at, ${TOOL} as tool, mcp_server, duration_ms, trace_id\n${TOOL_CALLS}\n  and status = 'error'\norder by started_at desc\nlimit 50`,
      WIDE,
    ),
  ],
};
