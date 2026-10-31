import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageHeader } from "@ratel/design-system/page-header";
import { Plus } from "lucide-react";
import Link from "next/link";
import { loadSkillsCatalog, loadToolsCatalog } from "@/lib/console/catalog/load";
import type { Organization } from "@/lib/platform/identity/schema";
import type { Project } from "@/lib/platform/projects/schema";
import { CatalogHome } from "./CatalogHome";
import { SkillsCatalog } from "./SkillsCatalog";
import { ToolsCatalog } from "./ToolsCatalog";

/**
 * The Catalog pages (DESIGN.md), rendered by the route files. Each one loads
 * on the server and hands a client view the rows and the server's "now".
 */

/** `/catalogs`: the tree of every tool and skill, the picked one beside it. */
export async function CatalogHomeV2Page({
  project,
  organization,
}: {
  project: Project;
  organization: Organization;
}) {
  const [tools, skills] = await Promise.all([
    loadToolsCatalog(project.id),
    loadSkillsCatalog(project.id, organization, { bodies: false }),
  ]);
  const root = `/project/${encodeURIComponent(project.id)}`;
  return (
    // The explorer fills the screen under the header, and each pane scrolls on its own.
    <Page className="lg:h-[calc(100dvh-var(--support-bar,0px))]">
      <PageHeader
        title="Catalog"
        description="Every tool and skill your agent can use, and how each one is found."
        actions={
          <>
            <Link href={`${root}/playground`} className={buttonVariants({ variant: "secondary" })}>
              Test a search
            </Link>
            <Link
              href={`${root}/catalogs/skills?new=1`}
              className={buttonVariants({ variant: "secondary" })}
            >
              <Plus aria-hidden strokeWidth={1.5} />
              New skill
            </Link>
          </>
        }
      />
      <CatalogHome
        projectId={project.id}
        now={new Date().toISOString()}
        tools={tools}
        skills={skills}
      />
    </Page>
  );
}

/** `/catalogs/tools`. */
export async function ToolsV2Page({ project }: { project: Project }) {
  const data = await loadToolsCatalog(project.id);
  return (
    <Page>
      <ToolsCatalog projectId={project.id} now={new Date().toISOString()} data={data} />
    </Page>
  );
}

/** `/catalogs/skills`. */
export async function SkillsV2Page({
  project,
  organization,
}: {
  project: Project;
  organization: Organization;
}) {
  const data = await loadSkillsCatalog(project.id, organization);
  return (
    <Page>
      <SkillsCatalog
        projectId={project.id}
        projectSlug={project.slug}
        now={new Date().toISOString()}
        data={data}
      />
    </Page>
  );
}
