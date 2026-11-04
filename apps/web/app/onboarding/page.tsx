import { notFound, redirect } from "next/navigation";
import { CelebrationBadger } from "@/components/console/badgers/honeybadgers";
import { OnboardingBackground } from "@/components/console/onboarding/OnboardingBackground";
import { composition } from "@/lib/composition";
import { BASE_URL } from "@/lib/platform/app-config";
import { isDbConfigured } from "@/lib/platform/db/client";
import { billableProjectCount, checkQuota } from "@/lib/platform/entitlements";
import { PROJECT_LIMIT_PARAM, PROJECT_LIMIT_VALUE } from "@/lib/platform/projects/capacity";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";
import { trackProductEvent } from "@/lib/platform/telemetry";
import { CreateProjectForm } from "./CreateProjectForm";

export const metadata = {
  title: "New project",
};

/** Session and database reads on every request; nothing here to prerender. */
export const dynamic = "force-dynamic";

/**
 * The first-run screen: outside the console shell on purpose (no rail, a full-bleed backdrop),
 * so it sits at `app/onboarding` as upstream does. The root layout gives it fonts and the app
 * config. An edition's access gate wraps it, as it wraps the console.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ organization?: string | string[] }>;
}) {
  // Where this edition's SDK snippets point (`BASE_URL` ends in /api/v1), so a self-hosted
  // deployment's reveal names its own ingest endpoint.
  const ingestUrl = `${BASE_URL}/traces`;
  const requestedOrganization = (await searchParams).organization;
  let formOrganization:
    | { id: string; name: string; slug: string; isFirstProject: boolean }
    | undefined;

  // Guard: this screen only makes sense when the account can actually create a
  // project. If it's already at its plan's project cap, there's nothing to set up
  // here — reaching this page (typically via the browser back button) would
  // otherwise show a form that can only fail on submit. Send them to their
  // projects instead. Accounts with room (every one in this edition) fall through
  // to the form.
  //
  // Note: the create → API-key-reveal flow relies on this page NOT re-rendering
  // on the server after a project is created — the key is shown once, client-side,
  // via `useActionState` (see CreateProjectForm/KeyReveal). So `createProjectAction`
  // must not revalidate this route: a re-render here would hit this guard (now at
  // cap) and redirect away before the key is ever displayed.
  if (isDbConfigured()) {
    const ctx = await getSessionContext();
    if (ctx) {
      const organization = ctx.organization;
      // One organization in this edition: a requested slug is the session's or nothing.
      if (
        typeof requestedOrganization === "string" &&
        requestedOrganization !== organization.slug
      ) {
        notFound();
      }
      const projects = await listProjectsForOrganization(organization.id);
      const quota = checkQuota(organization, "maxProjects", billableProjectCount(projects));
      if (!quota.ok) {
        await trackProductEvent(
          "quota_limit_hit",
          { externalId: ctx.user.externalId, orgId: organization.id },
          { limit: "maxProjects", cap: quota.limit },
        );
        redirect(
          `/org/${encodeURIComponent(organization.slug)}?${PROJECT_LIMIT_PARAM}=${PROJECT_LIMIT_VALUE}`,
        );
      }
      formOrganization = {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        isFirstProject: projects.length === 0,
      };
    }
  }

  const ConsoleAccessGate = (await composition.ui?.())?.ConsoleAccessGate;
  const page = (
    <main className="relative flex min-h-dvh items-center justify-center px-4 py-10 sm:py-16">
      <OnboardingBackground />
      {/* The naming step keeps itself to `max-w-lg` (see Card); the key reveal
          spends the full width so its key + quickstart clear the fold. */}
      <div className="relative z-10 w-full max-w-4xl">
        <CreateProjectForm
          ingestUrl={ingestUrl}
          keyIssuedCameo={
            <CelebrationBadger className="relative h-full w-full object-contain text-cream-dim drop-shadow-[0_14px_28px_rgba(0,0,0,0.7)]" />
          }
          organization={formOrganization}
        />
      </div>
    </main>
  );
  return ConsoleAccessGate ? <ConsoleAccessGate>{page}</ConsoleAccessGate> : page;
}
