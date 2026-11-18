import Link from "next/link";
import { Card, PageHeader, Section } from "@/components/console/quality/admin/primitives";
import { fmtAgo, fmtInt } from "@/components/console/quality/report/format";
import { loadOperatorQualityIndex } from "@/lib/views/quality/operator-pages";

export const dynamic = "force-dynamic";

/**
 * The quality index: every project running a shadow calibration, and how much
 * evidence each one has. Deliberately a list of populations rather than a league
 * table of scores, because a score without its `n` beside it invites comparing a
 * partner's week against another's afternoon.
 *
 * Owned (ADR-0030): the core draws it inside the edition's operator console
 * (`EditionUi.OperatorConsole`), whose `authorize` runs before any read in place of
 * upstream's platform-admin gate. Without the console it is a 404.
 */
export default async function AdminQualityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days } = await searchParams;
  const page = await loadOperatorQualityIndex(days);
  const { Frame } = page;

  if (page.state === "no-database") {
    return (
      <Frame>
        <PageHeader title="Quality" />
        <Card>
          <p className="text-sm text-warm-muted">No database connected.</p>
        </Card>
      </Frame>
    );
  }

  const { projects, windowDays } = page;

  return (
    <Frame>
      <PageHeader
        title="Quality"
        subtitle={`Search quality against each partner's own baseline, over the last ${windowDays} days. Computed from shadow comparisons: no judge, no sampling.`}
      />

      <Section title="Projects running a shadow calibration">
        {projects.length === 0 ? (
          <Card>
            <p className="text-sm text-warm-muted">
              No shadow comparisons in this window. A project appears here once its SDK exports{" "}
              <code className="text-cream-dim">ratel.experiment.comparison</code> records, which is
              what a shadow rollout emits.
            </p>
          </Card>
        ) : (
          <Card className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-forest-300 text-left text-xs uppercase tracking-wide text-warm-muted">
                  <th className="px-4 py-2 font-medium">Project</th>
                  <th className="px-4 py-2 font-medium">Organization</th>
                  <th className="px-4 py-2 font-medium">Calibrations</th>
                  <th className="px-4 py-2 text-right font-medium">Comparisons</th>
                  <th className="px-4 py-2 text-right font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr
                    key={project.projectId}
                    className="border-b border-forest-300/40 last:border-0"
                  >
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/admin/quality/${project.projectId}`}
                        className="text-cream hover:text-coral"
                      >
                        {project.projectName}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-warm-muted">
                      {project.organizationName ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-cream-dim">
                      {project.calibrations
                        .map((calibration) => calibration.experimentName)
                        .join(", ") || "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-cream">
                      {fmtInt(project.comparisonCount)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-[11px] text-warm-muted">
                      {fmtAgo(project.lastSeenAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>
    </Frame>
  );
}
