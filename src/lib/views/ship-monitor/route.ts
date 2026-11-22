import type { LoadWatchesOptions } from "./load";
import type { ShipmentWatch } from "./watch";

/**
 * The ship watch endpoint's logic (`app/api/projects/[projectId]/ship/watch`),
 * read every few seconds by Ship's watch cards. Every boundary is injected so
 * it is tested without Next or a database. With `FF_SHIP_MONITOR` off the
 * endpoint does not exist for the caller (404).
 */

export interface WatchQuery {
  shipmentId?: string;
}

export interface WatchRouteDeps {
  dbConfigured: () => boolean;
  getSession: () => Promise<{ userId: string } | null>;
  /** The project for this member, and whether the watch is on for them in its organization. */
  findProject: (
    projectId: string,
    userId: string,
  ) => Promise<{ projectId: string; organizationId: string; enabled: boolean } | null>;
  loadWatches: (projectId: string, options: LoadWatchesOptions) => Promise<ShipmentWatch[]>;
  now: () => Date;
  setLogContext: (fields: { project_id: string; org_id: string }) => void;
  logError: (fields: Record<string, unknown>, message: string) => void;
  reportException: (
    error: unknown,
    distinctId: string,
    properties: Record<string, unknown>,
  ) => void;
}

export type WatchResponseBody =
  | { ok: true; watches: ShipmentWatch[] }
  | { ok: false; message: string };

const NO_STORE = { "cache-control": "no-store" };

export async function watchResponse(
  projectId: string,
  query: WatchQuery,
  deps: WatchRouteDeps,
): Promise<Response> {
  if (!deps.dbConfigured()) return fail(404, "The ship watch isn't available yet.");
  const session = await deps.getSession();
  if (!session) return fail(401, "Sign in to watch shipped changes.");
  const scope = await deps.findProject(projectId, session.userId);
  if (!scope || !scope.enabled) return fail(404, "Not found.");
  deps.setLogContext({ project_id: scope.projectId, org_id: scope.organizationId });
  try {
    const watches = await deps.loadWatches(scope.projectId, {
      now: deps.now(),
      ...(query.shipmentId ? { shipmentId: query.shipmentId } : {}),
    });
    return Response.json({ ok: true, watches } satisfies WatchResponseBody, { headers: NO_STORE });
  } catch (err) {
    deps.logError({ err, project_id: scope.projectId }, "ship watch read failed");
    deps.reportException(err, `project:${scope.projectId}`, { operation: "ship_watch" });
    return fail(503, "Couldn't read the watch. It tries again in a moment.");
  }
}

function fail(status: number, message: string): Response {
  return Response.json({ ok: false, message } satisfies WatchResponseBody, {
    status,
    headers: NO_STORE,
  });
}
