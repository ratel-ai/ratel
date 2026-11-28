import { findProjectScope } from "@/lib/console/scope/project-scope";
import { getDb } from "@/lib/platform/db/client";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { billingSelfServe, getLimits } from "@/lib/platform/entitlements";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { NO_USAGE, type RqlCompletionUsage } from "@/lib/synthesis/rql/compile";
import { loadCompletionUsage } from "@/lib/views/dashboards/completion-usage";
import { NO_PROPERTIES, type PropertyChoices } from "@/lib/views/dashboards/properties";
import { loadPropertyChoices } from "@/lib/views/dashboards/property-choices";

/**
 * The trace properties the metric forms offer (RTL-396), with the plan's entitlement and the
 * console's upgrade link for the tooltip of a detected one. None when the read fails: the forms
 * then show their built-in fields only.
 */
export async function loadFormProperties(
  projectId: string,
  range: { since: Date; until?: Date },
): Promise<PropertyChoices> {
  return loadOrFallback({
    operation: "form_properties",
    distinctId: `project:${projectId}`,
    fallback: NO_PROPERTIES,
    load: async () => {
      const scope = await findProjectScope(projectId);
      if (!scope) return NO_PROPERTIES;
      const { organization } = scope;
      const entitled = (getLimits(organization).maxIndexedPropertiesPerProject ?? 0) > 0;
      const upgradeHref = billingSelfServe(organization)
        ? `/org/${encodeURIComponent(organization.slug)}/billing`
        : null;
      return withStatementTimeout(
        (db) => loadPropertyChoices(projectId, range, { db, entitled, upgradeHref }),
        { operation: "form_properties", timeoutMs: supplementaryReadTimeoutMs() },
      );
    },
  });
}

/**
 * What the RQL field of the forms orders its list by (`completion-usage.ts`), read once at page
 * load. None when the read fails: the list then keeps its fixed start order.
 */
export async function loadFormCompletionUsage(projectId: string): Promise<RqlCompletionUsage> {
  return loadOrFallback({
    operation: "form_completion_usage",
    distinctId: `project:${projectId}`,
    fallback: NO_USAGE,
    // Two bounded reads of the primary database and one RQL read per table on the RQL pool, with
    // its own timeout: no transaction is held open across them.
    load: () => loadCompletionUsage(projectId, { db: getDb() }),
  });
}
