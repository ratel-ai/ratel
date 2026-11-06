import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Callout } from "@ratel/design-system/states";
import { notFound } from "next/navigation";
import {
  PROJECT_SEARCH_PARAM,
  projectListItems,
  projectUsageLabel,
} from "@/lib/console/settings/projects";
import { projectCapacity, projectLimitMessage } from "@/lib/platform/projects/capacity";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";
import { NewProjectDialog } from "./NewProjectDialog";
import { ProjectsList } from "./ProjectsList";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/**
 * The organization's home: its projects, searchable, and the one primary action, New project. At
 * the plan's cap the action is off and a single notice says why.
 */
export async function ProjectsPage({
  slug,
  searchParams,
}: {
  slug: string;
  searchParams: SearchParams;
}) {
  const context = await getSessionContext();
  if (!context || context.organization.slug !== slug) notFound();
  const { organization } = context;
  const projects = await listProjectsForOrganization(organization.id);
  const capacity = projectCapacity(organization, projects);
  const newProject = (
    <NewProjectDialog organizationSlug={organization.slug} atCap={capacity.atCap} />
  );

  return (
    <Page>
      <PageHeader title="Projects" actions={newProject} />
      <PageBody className="*:min-w-0">
        {capacity.atCap ? (
          <Callout tone="info">
            {projectLimitMessage(capacity)} Delete a project to add another.
          </Callout>
        ) : null}
        <ProjectsList
          projects={projectListItems(projects)}
          usage={projectUsageLabel(capacity)}
          usageNote={
            capacity.hasDemoProject ? "The demo project doesn't count toward the limit." : null
          }
          initialQuery={first(searchParams[PROJECT_SEARCH_PARAM])}
          emptyAction={newProject}
        />
      </PageBody>
    </Page>
  );
}
