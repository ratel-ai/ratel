import { currentLogContext, runWithLogContext } from "@/lib/platform/logger";
import {
  type LookupProjectLabels,
  lookupProjectLabels,
  type ProjectLabels,
} from "@/lib/platform/request-log-labels";

/**
 * Run background work for one project inside a log context that names the
 * project and its organization, as `setRequestLogContext` does for a request.
 * Every log line inside carries `project_id`, `org_id`, `org_slug` and
 * `project_path`, and `model_call` lines read their organization and labels
 * from it.
 *
 * The organization and labels come from the request log's cached project
 * lookup (one query per project per ten minutes). A failed lookup leaves them
 * out, labels of an outer project included; the work runs either way.
 */
export async function withProjectLogContext<T>(
  projectId: string,
  work: () => Promise<T>,
  lookup: LookupProjectLabels = lookupProjectLabels,
): Promise<T> {
  let labels: ProjectLabels | null = null;
  try {
    labels = await lookup(projectId);
  } catch {
    // The lookup logs its own failure; the work still runs.
  }
  const { org_slug: _slug, project_path: _path, ...outer } = currentLogContext();
  return runWithLogContext(
    {
      ...outer,
      project_id: projectId,
      ...(labels
        ? { org_id: labels.org_id, org_slug: labels.org_slug, project_path: labels.project_path }
        : {}),
    },
    work,
  );
}
