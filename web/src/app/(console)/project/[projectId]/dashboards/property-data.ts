import { findProjectScope } from "@/lib/console/scope/project-scope";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { billingSelfServe, getLimits } from "@/lib/platform/entitlements";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { NO_PROPERTIES, type PropertyChoices } from "@/lib/views/dashboards/properties";
import { loadPropertyChoices } from "@/lib/views/dashboards/property-choices";

/**
 * The trace properties the metric forms offer (RTL-396), with the plan's entitlement and the
 * console's upgrade link for the tooltip of a detected one. None while `customMonitoring` is off,
 * and none when the read fails: the forms then show their built-in fields only.
 */
export async function loadFormProperties(
  projectId: string,
  range: { since: Date; until?: Date },
  customMonitoring: boolean,
): Promise<PropertyChoices> {
  if (!customMonitoring) return NO_PROPERTIES;
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
