import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Callout } from "@ratel/design-system/states";
import { notFound } from "next/navigation";
import { startProjectCreationAction } from "@/app/(console)/org/[orgSlug]/actions";
import {
  PROJECT_SEARCH_PARAM,
  projectListItems,
  projectUsageLabel,
} from "@/lib/console/settings/projects";
import {
  PROJECT_LIMIT_PARAM,
  PROJECT_LIMIT_VALUE,
  projectCapacity,
  projectLimitMessage,
} from "@/lib/platform/projects/capacity";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";
import { NewProjectButton } from "./NewProjectButton";
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
  const createProject = startProjectCreationAction.bind(null, organization.slug);
  // Set by whichever surface refused: the action behind the button, or /onboarding.
  const refused = first(searchParams[PROJECT_LIMIT_PARAM]) === PROJECT_LIMIT_VALUE;
  const newProject = <NewProjectButton action={createProject} atCap={capacity.atCap} />;

  return (
    <Page>
      <PageHeader title="Projects" actions={newProject} />
      <PageBody className="*:min-w-0">
        {capacity.atCap || refused ? (
          <Callout
            tone={refused ? "warning" : "info"}
            title={refused ? "You're at your plan's project limit" : undefined}
          >
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
