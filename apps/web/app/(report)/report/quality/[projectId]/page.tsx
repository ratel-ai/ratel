import { notFound } from "next/navigation";
import { PrintButton } from "@/components/console/quality/report/PrintButton";
import { ReportDocument } from "@/components/console/quality/report/ReportDocument";
import "@/components/console/quality/report/quality.css";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { listQualityCalibrations } from "@/lib/synthesis/quality/queries";
import { loadQualityView } from "@/lib/synthesis/quality/service";
import {
  loadFingerprintChanges,
  loadFirstFingerprintAt,
  loadQualityTrend,
} from "@/lib/synthesis/quality/snapshot";
import { parseWindowDays, resolveQualityWindow } from "@/lib/synthesis/quality/window";

export const dynamic = "force-dynamic";

/**
 * The printable partner report.
 *
 * Gated on its own rather than relying on the route group: this sits outside
 * `(console)`, so it does not inherit the console's layout check, and the report
 * contains a customer's real query volumes and catalog shape.
 *
 * Owned (ADR-0030): a member's report, so the project comes from the console scope
 * (a 404 outside the organization) in place of upstream's platform-admin gate. The
 * quality stylesheet, which upstream loads globally, is loaded here: only this page
 * draws the quality charts and panels in this edition.
 */
export default async function QualityReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ days?: string; calibration?: string }>;
}) {
  if (!isDbConfigured()) notFound();
  const [{ projectId: requestedProjectId }, { days, calibration }] = await Promise.all([
    params,
    searchParams,
  ]);
  const { project } = await requireProjectScope(requestedProjectId);
  const projectId = project.id;
  const window = resolveQualityWindow(days);
  const windowDays = parseWindowDays(days);
  const db = getDb();

  const calibrations = await listQualityCalibrations(projectId, window, db);
  const experimentName = calibration ?? calibrations[0]?.experimentName;
  if (!experimentName) notFound();

  const [view, trend, fingerprintChanges, firstFingerprintAt] = await Promise.all([
    loadQualityView(projectId, experimentName, window, db),
    loadQualityTrend(projectId, experimentName, window, db),
    loadFingerprintChanges(projectId, window, db),
    loadFirstFingerprintAt(projectId, db),
  ]);
  if (!view) notFound();

  return (
    <>
      <div className="report-toolbar">
        <span>
          A4 &middot; print to PDF from your browser for selectable text and vector charts
        </span>
        <PrintButton />
      </div>
      <ReportDocument
        view={view}
        trend={trend}
        fingerprintChanges={fingerprintChanges}
        firstFingerprintAt={firstFingerprintAt}
        generatedAt={new Date()}
        windowDays={windowDays}
      />
    </>
  );
}
