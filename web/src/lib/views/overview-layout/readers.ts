import { findProjectScope } from "@/lib/console/scope/project-scope";
import type { SessionUser } from "@/lib/contracts/session";
import { getDb } from "@/lib/platform/db/client";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import {
  type LayoutDeps,
  type LayoutReader,
  type LayoutSnapshot,
  readOverviewLayout,
} from "./actions";
import { createDrizzleOverviewLayoutStore } from "./adapters/drizzle-store";
import { findDashboardWidget } from "./dashboard-widgets";
import { DEFAULT_LAYOUT, WIDGET_CATALOG } from "./domain/layout";
import { projectDashboardsOn } from "./offered";

/** The web's side: the signed-in person, with the console's own project check. */
export interface WebReaderDeps {
  scope: (
    projectId: string,
  ) => Promise<{ project: { id: string }; user: Pick<SessionUser, "externalId"> } | null>;
  restricted: () => Promise<boolean>;
}

export function webLayoutReader(
  deps: WebReaderDeps = { scope: findProjectScope, restricted: isRestrictedBySupportSession },
): LayoutDeps["reader"] {
  return async (projectId): Promise<LayoutReader | null> => {
    const scope = await deps.scope(projectId);
    if (!scope) return null;
    return {
      kind: "person",
      projectId: scope.project.id,
      personId: scope.user.externalId,
      restricted: await deps.restricted(),
    };
  };
}

export const webLayoutDeps: LayoutDeps = {
  reader: webLayoutReader(),
  store: () => createDrizzleOverviewLayoutStore(getDb()),
  offered: async () => WIDGET_CATALOG,
  dashboardsOn: (projectId) => projectDashboardsOn(projectId),
  dashboardWidget: (projectId, ref) => findDashboardWidget(projectId, ref),
  source: async () => ({ kind: "web" }),
};

/**
 * The layout for the page: the default when it could not be read (`read: false`). Nothing may be
 * saved then, as a change of the default would replace the layout that was not read.
 */
export function pageLayout(
  projectId: string,
  deps: LayoutDeps = webLayoutDeps,
): Promise<LayoutSnapshot & { read: boolean }> {
  const unread = { layout: DEFAULT_LAYOUT, revision: "", undo: null, read: false };
  return loadOrFallback({
    operation: "overview_layout",
    distinctId: `project:${projectId}`,
    fallback: unread,
    load: async () => {
      const result = await readOverviewLayout(projectId, deps);
      if (!result.ok) return unread;
      const { layout, revision, undo } = result;
      return { layout, revision, undo, read: true };
    },
  });
}
