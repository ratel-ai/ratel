import { findProjectScope, type ProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import type { MetricFeatures } from "@/lib/synthesis/metrics/catalog";

/** The reader's project, or null where no database is connected. The project layout already guarded the id. */
export async function dashboardsScope(projectId: string): Promise<ProjectScope | null> {
  return isDbConfigured() ? findProjectScope(projectId) : null;
}

/** Whether the project's organization has `customMonitoring`. */
export async function dashboardsEnabled(projectId: string): Promise<boolean> {
  const scope = await dashboardsScope(projectId);
  return featureEnabled("customMonitoring", scope ? { organizationId: scope.organization.id } : {});
}

/** The switches that decide which metrics the project's widgets may use. */
export async function metricFeatures(subject: {
  projectId: string;
  organizationId: string;
  actor: string;
}): Promise<MetricFeatures> {
  return { customMonitoring: await featureEnabled("customMonitoring", subject) };
}
