import { sql } from "drizzle-orm";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";

/**
 * The holds as this process knows them, at most {@link HOLD_CACHE_MS} old. A failed read keeps
 * the last answer, and logs.
 */
export const HOLD_CACHE_MS = 2_000;

export interface HoldSnapshot {
  /** Projects named by a hold of their own. */
  projects: ReadonlySet<string>;
  /** Organizations on hold as a whole. */
  organizations: ReadonlySet<string>;
}

export const NO_HOLDS: HoldSnapshot = { projects: new Set(), organizations: new Set() };

type StateDb = Pick<ReturnType<typeof getDb>, "execute">;

const logger = getLogger("platform/org-hold");

export function createHoldReader(deps: { load: () => Promise<HoldSnapshot>; now?: () => number }) {
  const now = deps.now ?? Date.now;
  let current: HoldSnapshot = NO_HOLDS;
  let loadedAt = Number.NEGATIVE_INFINITY;
  let loading: Promise<HoldSnapshot> | null = null;
  return {
    async read(): Promise<HoldSnapshot> {
      if (now() - loadedAt < HOLD_CACHE_MS) return current;
      loading ??= deps
        .load()
        .then((snapshot) => {
          current = snapshot;
          return snapshot;
        })
        .catch((err: unknown) => {
          logger.error({ err }, "hold read failed");
          return current;
        })
        .finally(() => {
          loadedAt = now();
          loading = null;
        });
      return loading;
    },
    invalidate() {
      loadedAt = Number.NEGATIVE_INFINITY;
    },
  };
}

export async function loadHolds(db: StateDb = getDb()): Promise<HoldSnapshot> {
  const result = await db.execute<{ organization_id: string | null; project_id: string | null }>(
    sql`select organization_id, project_id from org_holds`,
  );
  if (result.rows.length === 0) return NO_HOLDS;
  return {
    projects: new Set(result.rows.flatMap((row) => row.project_id ?? [])),
    organizations: new Set(result.rows.flatMap((row) => row.organization_id ?? [])),
  };
}

const reader = createHoldReader({ load: () => loadHolds() });

export async function readHolds(): Promise<HoldSnapshot> {
  return isDbConfigured() ? reader.read() : NO_HOLDS;
}

export function invalidateHolds(): void {
  reader.invalidate();
}

/** Whether a project is on hold, by itself or with its organization. */
export async function projectOnHold(project: {
  id: string;
  organizationId: string;
}): Promise<boolean> {
  const holds = await readHolds();
  return holds.projects.has(project.id) || holds.organizations.has(project.organizationId);
}

export async function organizationOnHold(organizationId: string): Promise<boolean> {
  return (await readHolds()).organizations.has(organizationId);
}
