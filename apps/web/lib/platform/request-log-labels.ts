import { eq } from "drizzle-orm";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { organizations } from "@/lib/platform/db/test-support";
import { getLogger } from "@/lib/platform/logger";
import { projects } from "@/lib/platform/projects/schema";

/** Readable names for a project on the request log, so dashboards can group by
 * them instead of ids. `project_path` is `<org slug>/<project slug>`: project
 * slugs repeat across organizations ("default"), the pair does not. */
export type ProjectLabels = {
  org_id: string;
  org_slug: string;
  project_path: string;
};

export type LookupProjectLabels = (projectId: string) => Promise<ProjectLabels | null>;

type CacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;
const logger = getLogger("request-log");

/**
 * Caches lookups per project so a busy project costs one query per task every
 * `ttlMs`. Concurrent misses share one query. A failed lookup resolves to null
 * and is not cached: the log line goes out with ids only.
 */
export function cacheProjectLabels(
  lookup: LookupProjectLabels,
  { ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now }: CacheOptions = {},
): LookupProjectLabels {
  const entries = new Map<string, { expiresAt: number; labels: Promise<ProjectLabels | null> }>();

  return (projectId) => {
    const cached = entries.get(projectId);
    if (cached && cached.expiresAt > now()) return cached.labels;

    if (entries.size >= maxEntries) entries.clear();
    const labels = lookup(projectId).catch((error: unknown) => {
      entries.delete(projectId);
      logger.warn({ err: error, project_id: projectId }, "request_log_labels_failed");
      return null;
    });
    entries.set(projectId, { expiresAt: now() + ttlMs, labels });
    return labels;
  };
}

async function queryProjectLabels(projectId: string): Promise<ProjectLabels | null> {
  if (!isDbConfigured()) return null;
  const [row] = await getDb()
    .select({
      orgId: organizations.id,
      orgSlug: organizations.slug,
      projectSlug: projects.slug,
    })
    .from(projects)
    .innerJoin(organizations, eq(projects.organizationId, organizations.id))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  return {
    org_id: row.orgId,
    org_slug: row.orgSlug,
    project_path: `${row.orgSlug}/${row.projectSlug}`,
  };
}

export const lookupProjectLabels: LookupProjectLabels = cacheProjectLabels(queryProjectLabels);
