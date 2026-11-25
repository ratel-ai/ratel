import { findProjectScope } from "@/lib/console/scope/project-scope";
import type { SessionUser } from "@/lib/contracts/session";
import { getDb } from "@/lib/platform/db/client";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import type { LayoutDeps, LayoutReader } from "./actions";
import { createDrizzleOverviewLayoutStore } from "./adapters/drizzle-store";
import { WIDGET_CATALOG } from "./domain/layout";

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
};
