import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HealthReportDocument } from "@/components/console/health/report/HealthReportDocument";
import { ReportToolbar } from "@/components/console/health/report/ReportToolbar";
import { buildHealthReport } from "@/components/console/health/report/report-model";
import "@/components/console/health/report/health-report.css";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { trackProductEvent } from "@/lib/platform/telemetry";
import { applyPlanLimits, parseWindowDays } from "@/lib/readings/trace-signals/view";
import { loadHealthPageModel, workflowLabelsFor } from "@/lib/views/health/page-model";
import { publicHealthModel, publicWorkflowLabels } from "@/lib/views/health/public-model";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agent health report" };

/**
 * A member's printable Agent health report. Gated on its own (this route group inherits no
 * session check) and built from the redacted model: a PDF gets forwarded, so it never carries
 * example runs or user requests, whoever exports it.
 *
 * Owned (ADR-0030): the project comes from the console scope; the redacted model and its load
 * overrides are the ones upstream shares with its public link, which is not part of this edition.
 */
export default async function HealthReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ days?: string; print?: string }>;
}) {
  if (!isDbConfigured()) notFound();
  const [{ projectId }, { days, print }] = await Promise.all([params, searchParams]);
  const { project, organization, user } = await requireProjectScope(projectId);

  const limits = getAgentHealthLimits(organization);
  const windowDays = parseWindowDays(days, limits.agentHealthWindowDays);
  const loaded = await loadHealthPageModel(
    { projectId: project.id, windowDays },
    process.env.NODE_ENV,
    {
      // No example turns, model-written task names without their descriptions, no ask insights.
      getLimits: async () => ({ ...limits, agentHealthEvidenceTurns: 0 }),
      getLabels: async (id) => publicWorkflowLabels(await workflowLabelsFor(id)),
      getInsights: async () => null,
    },
  );
  const model = publicHealthModel(
    applyPlanLimits(loaded, { ...limits, agentHealthEvidenceTurns: 0 }),
  );

  await trackProductEvent(
    "health_report_opened",
    { externalId: user.externalId, orgId: organization.id, projectId: project.id },
    { window_days: windowDays, surface: "member" },
  );

  const report = buildHealthReport(model, {
    projectName: project.name,
    organizationName: organization.name,
    generatedAt: new Date(),
  });
  return (
    <>
      <ReportToolbar autoPrint={print === "1"} />
      <HealthReportDocument report={report} />
    </>
  );
}
