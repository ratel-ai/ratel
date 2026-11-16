import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { HealthReportDocument } from "@/components/console/health/report/HealthReportDocument";
import { ReportToolbar } from "@/components/console/health/report/ReportToolbar";
import { buildHealthReport } from "@/components/console/health/report/report-model";
import "@/components/console/health/report/health-report.css";
import { trackProductEvent } from "@/lib/platform/telemetry";
import { sharedHealthFor } from "@/lib/views/health/shared-page-load";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agent health report",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * The printable report behind a share link: the same redacted model the shared page renders,
 * laid out for A4, with `?print=1` opening the print dialog. Gated exactly like the page it came
 * from: an unknown or revoked link, and an edition without share links, are one 404.
 */
export default async function SharedHealthReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ print?: string }>;
}) {
  const [{ token }, { print }] = await Promise.all([params, searchParams]);
  const shared = await sharedHealthFor(token);
  if (!shared) notFound();

  after(() =>
    trackProductEvent(
      "health_report_opened",
      {
        externalId: `project:${shared.projectId}`,
        orgId: shared.organizationId,
        projectId: shared.projectId,
      },
      { window_days: shared.model.windowDays, surface: "shared" },
    ),
  );

  const report = buildHealthReport(shared.model, {
    projectName: shared.projectName,
    organizationName: shared.organizationName,
    generatedAt: new Date(),
  });
  return (
    <>
      <ReportToolbar autoPrint={print === "1"} />
      <HealthReportDocument report={report} />
    </>
  );
}
