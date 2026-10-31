import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { findProject } from "@/lib/console/navigation";
import { getConsoleScope } from "@/lib/console/shell-data";

export const dynamic = "force-dynamic";

const ENDPOINTS = [
  ["POST /v1/traces", "OTLP traces"],
  ["POST /v1/logs", "OTLP logs"],
  ["POST /api/v1/events", "runtime events"],
  ["GET /v1/catalog", "the published catalog"],
] as const;

/** A project's landing page. The layout above has already rejected a project outside the organization. */
export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const project = findProject((await getConsoleScope())?.projects ?? [], projectId);
  return (
    <Page>
      <PageHeader title="Overview" description={project?.name} />
      <PageBody>
        <Section title="Ingest" description="Where this project's API keys send data.">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            {ENDPOINTS.map(([endpoint, what]) => (
              <div key={endpoint} className="contents">
                <dt className="font-mono text-fg">{endpoint}</dt>
                <dd className="text-fg-muted">{what}</dd>
              </div>
            ))}
          </dl>
        </Section>
      </PageBody>
    </Page>
  );
}
