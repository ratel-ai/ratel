import { permanentRedirect, redirect } from "next/navigation";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { listIntentTools } from "@/lib/readings/tool-explorer/queries";
import { legacyAskId, legacyToolCraftTarget, tasksHref } from "@/lib/views/tasks/paths";
import { loadLatestTasksRun, taskOfAskTools } from "@/lib/views/tasks/queries";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tool craft's Asks became Tasks, under Agent health. Old links land there:
 * an open ask (`?ask=`, or `?peek=` from its v2 table) on the task its tools
 * run as when one is found, `?view=crafts` on Fixes, anything else on the
 * list. Its Suggestions keep their own path for now.
 */
export default async function LegacyToolCraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const askId = legacyAskId(query);
  if (!askId || !UUID.test(askId) || !isDbConfigured())
    permanentRedirect(legacyToolCraftTarget(projectId, query, null));

  // Owned (ADR-0030): the project comes from the console scope.
  const { project } = await requireProjectScope(projectId);
  const task = await loadOrFallback({
    operation: "tool_craft_legacy_ask",
    distinctId: `project:${project.id}`,
    fallback: null as string | null,
    load: () =>
      withStatementTimeout(
        async (db) => {
          const rows = await listIntentTools(
            project.id,
            { scope: "turn", intentId: askId, limit: 100 },
            db,
          );
          const run = await loadLatestTasksRun(project.id, db);
          return taskOfAskTools(
            rows.map((row) => ({ toolId: row.toolId, share: row.share })),
            run?.workflows ?? null,
          );
        },
        { operation: "tool_craft_legacy_ask" },
      ),
  });
  // Where an ask lands depends on today's tasks, so this one is not cached as permanent.
  redirect(task ? legacyToolCraftTarget(project.id, query, task) : tasksHref(project.id));
}
