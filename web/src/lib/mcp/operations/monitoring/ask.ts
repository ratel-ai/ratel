import { z } from "zod";
import { invalidParams, McpOperationError } from "@/lib/mcp/errors";
import {
  defaultMonitoringDeps,
  type MonitoringDeps,
  requireMonitoring,
} from "@/lib/mcp/operations/monitoring/deps";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { resolveWindow, windowParams } from "@/lib/mcp/windows";
import { RQL_LIMITS } from "@/lib/synthesis/rql/compile";
import { ASK_TARGETS } from "@/lib/views/ask/domain";
import { type DraftDeps, draftWidgets } from "@/lib/views/ask/draft";
import { ASK_MAX_WIDGETS, ASK_MAX_WORDS } from "@/lib/views/ask/limits";
import { getDashboard } from "@/lib/views/dashboards/store";

/**
 * Ask in words over MCP (`customMonitoring`): `draft_widgets` drafts RQL widgets from a sentence,
 * as the console's ask field does, with the same limits. It saves no widget and no dashboard: it
 * stores the ask, which the limits count. To keep a draft, the caller adds its widgets with
 * `change_dashboard` (add_widget) or makes a dashboard with `import_dashboard`.
 */

/** The page range of a draft: the last 7 days by default, at most the console's longest range. */
const ASK_WINDOW = { defaultDays: 7, maxDays: RQL_LIMITS.consoleMaxWindowDays } as const;

export function askOperations(
  deps: MonitoringDeps = defaultMonitoringDeps,
  askDeps: () => DraftDeps = () => ({}),
): McpOperation[] {
  return [
    defineOperation({
      id: "draft_widgets",
      domain: "observability",
      title: "Draft widgets from words",
      description: `Drafts RQL widgets from a sentence. Each has a title, RQL that compiles for the project and a chart (line, bar, number, table). refused names each widget that failed, with the reason. target dashboard: up to ${ASK_MAX_WIDGETS.dashboard} widgets for a new dashboard. target widget: one for dashboardId. Saves nothing: keep them with change_dashboard or import_dashboard.`,
      keywords: ["ask in words", "draft widgets", "widgets from a sentence", "build dashboard"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        words: z
          .string()
          .trim()
          .min(1, "Say what the widgets should show.")
          .max(ASK_MAX_WORDS, `The words have at most ${ASK_MAX_WORDS} characters.`)
          .describe(`What the widgets should show, at most ${ASK_MAX_WORDS} characters.`),
        target: z
          .enum(ASK_TARGETS)
          .default("dashboard")
          .describe(
            "dashboard: the widgets of a new dashboard. widget: one widget for dashboardId.",
          ),
        dashboardId: uuidParam()
          .optional()
          .describe("The dashboard a widget is for: the draft avoids its widgets."),
        since: windowParams.since.describe(
          "ISO 8601 start of the page range. Default: 7 days before until.",
        ),
        until: windowParams.until,
      }),
      async execute(ctx, params) {
        const caller = await requireMonitoring(deps, ctx);
        const dashboardId = params.dashboardId ?? null;
        if (params.target === "widget" && !dashboardId)
          throw invalidParams(
            "Pass dashboardId: target widget drafts a widget for that dashboard.",
          );
        if (dashboardId && !(await getDashboard(caller.projectId, dashboardId, deps.db())))
          throw new McpOperationError("not_found", "The dashboard does not exist.");
        const window = resolveWindow(params, ASK_WINDOW, deps.now());
        const result = await draftWidgets(
          {
            projectId: caller.projectId,
            actor: caller.actor,
            surface: "mcp",
            target: params.target,
            dashboardId,
            words: params.words,
            range: { from: window.since.toISOString(), to: window.until.toISOString() },
          },
          { db: deps.db() as never, now: deps.now, ...askDeps() },
        );
        switch (result.status) {
          case "drafted":
            return {
              data: {
                askId: result.askId,
                model: result.model,
                widgets: result.widgets,
                refused: result.refused,
              },
              window: window.toJSON(),
              hint: "Nothing is saved. Add a widget with change_dashboard (add_widget), or make a dashboard of them with import_dashboard.",
            };
          case "limited":
            throw new McpOperationError("rate_limited", result.message, {
              reason: result.limit,
              retryAfterSeconds: Math.max(
                1,
                Math.ceil((Date.parse(result.resetsAt) - deps.now().getTime()) / 1000),
              ),
            });
          case "not_set_up":
            throw new McpOperationError("unavailable", result.message, { reason: "not_set_up" });
          case "invalid":
            throw invalidParams(result.message);
          case "failed":
            throw new McpOperationError("unavailable", result.message, { reason: "draft_failed" });
        }
      },
    }),
  ];
}
