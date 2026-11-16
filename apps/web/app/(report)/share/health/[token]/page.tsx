import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { HealthReportDocument } from "@/components/console/health/report/HealthReportDocument";
import { ReportToolbar } from "@/components/console/health/report/ReportToolbar";
import { buildHealthReport } from "@/components/console/health/report/report-model";
import "@/components/console/health/report/health-report.css";
import { trackProductEvent } from "@/lib/platform/telemetry";
import { hasSignals } from "@/lib/readings/trace-signals/view";
import { isLinkPreviewAgent } from "@/lib/views/health/share-preview";
import { recordSharedHealthView, sharedHealthFor } from "@/lib/views/health/shared-page-load";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const shared = await sharedHealthFor((await params).token);
  return {
    title: shared ? `${shared.projectName} · Agent health` : "Agent health",
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

/**
 * The public, read-only Agent health page behind a share link. No session: the token is the only
 * credential, and the model is redacted before it gets here (`publicHealthModel`). Unknown and
 * revoked links, and an edition without share links, are one 404.
 *
 * Owned (ADR-0030): upstream renders its interactive health page under a share bar; here the
 * link opens the report, the same document a member downloads. The link and its view count are
 * the edition's (`EditionUi.HealthShare`).
 */
export default async function SharedHealthPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const shared = await sharedHealthFor(token);
  if (!shared) notFound();

  // Link previews (Slack, iMessage, crawlers) load the page too; they are not people opening it.
  const preview = isLinkPreviewAgent((await headers()).get("user-agent"));
  after(async () => {
    if (preview) return;
    await recordSharedHealthView(shared);
    await trackProductEvent(
      "health_share_viewed",
      {
        externalId: `project:${shared.projectId}`,
        orgId: shared.organizationId,
        projectId: shared.projectId,
      },
      { surface: "page", has_signals: hasSignals(shared.model) },
    );
  });

  const report = buildHealthReport(shared.model, {
    projectName: shared.projectName,
    organizationName: shared.organizationName,
    generatedAt: new Date(),
  });
  return (
    <>
      <ReportToolbar autoPrint={false} />
      <HealthReportDocument report={report} />
    </>
  );
}
