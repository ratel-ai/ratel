import { notFound } from "next/navigation";
import { SkillsV2Page } from "@/components/console/catalog/CatalogPages";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { dbConfigured } from "@/lib/platform/db/request";
import { getProjectById } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";

export const metadata = { title: "Skills" };

export default async function ScopedSkillsCatalogPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  if (!(await dbConfigured())) {
    return (
      <DatabaseUnavailable title="Skills">
        Skills become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { projectId } = await params;
  const context = await getSessionContext();
  if (!context) notFound();
  // The project layout already checked the reader may see the project (a member of its organization).
  const project = await getProjectById(projectId);
  if (!project) notFound();
  const { organization } = context;
  return <SkillsV2Page project={project} organization={organization} />;
}
