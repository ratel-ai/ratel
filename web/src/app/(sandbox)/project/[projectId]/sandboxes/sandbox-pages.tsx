import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { SandboxesList } from "@/components/console/sandboxes/SandboxesList";
import { SandboxView } from "@/components/console/sandboxes/SandboxView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getConfig } from "@/config";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { publicBaseUrl } from "@/lib/platform/public-url";
import { sealedSecretsKey } from "@/lib/platform/sealed-secrets";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { createDrizzleRunStore } from "@/lib/views/sandboxes/adapters/drizzle-run-store";
import { createDrizzleSandboxIndex } from "@/lib/views/sandboxes/adapters/drizzle-sandbox-index";
import { createDrizzleSecretStore } from "@/lib/views/sandboxes/adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "@/lib/views/sandboxes/adapters/drizzle-version-store";
import {
  sandboxProviderConfigured,
  sandboxProviderKind,
} from "@/lib/views/sandboxes/adapters/provider-from-env";
import { sandboxesEnabledForProject } from "@/lib/views/sandboxes/gate";
import {
  configurationProblems,
  loadSandboxDetail,
  loadSandboxList,
} from "@/lib/views/sandboxes/page-model";
import type { SandboxSection } from "@/lib/views/sandboxes/paths";

/**
 * The server side of the Sandboxes pages (the `evals` flag). Next renders a page next to its
 * layout, so each page reads the flag again before it loads data: with the flag off it answers 404
 * and loads nothing (decision `flag-off-page-status`).
 */
export async function sandboxListPage(projectId: string): Promise<ReactNode> {
  const context = await pageContext(projectId);
  if ("unavailable" in context) return context.unavailable;
  const { project, canEdit, db, server } = context;
  const model = await withFeatureSpan(
    "sandboxes",
    "load_list",
    () =>
      loadSandboxList(project.id, canEdit, {
        ...server,
        index: createDrizzleSandboxIndex(db),
        secrets: createDrizzleSecretStore(db),
      }),
    { attributes: { "project.id": project.id } },
  );
  return (
    <SandboxesList
      model={model}
      projectName={project.name}
      ratelUrl={publicBaseUrl()}
      now={new Date().toISOString()}
    />
  );
}

/** One section of one sandbox. A name with no version answers 404. */
export async function sandboxSectionPage(
  projectId: string,
  name: string,
  section: SandboxSection,
  versionId: string | null = null,
): Promise<ReactNode> {
  const context = await pageContext(projectId);
  if ("unavailable" in context) return context.unavailable;
  const { project, canEdit, canSaveCases, db, server } = context;
  const model = await withFeatureSpan(
    "sandboxes",
    "load_sandbox",
    () =>
      loadSandboxDetail(project.id, decodeURIComponent(name), canEdit, {
        ...server,
        versions: createDrizzleVersionStore(db),
        secrets: createDrizzleSecretStore(db),
        runs: createDrizzleRunStore(db),
      }),
    { attributes: { "project.id": project.id } },
  );
  if (!model) notFound();
  return (
    <SandboxView
      model={model}
      section={section}
      configurationVersionId={versionId}
      canSaveCases={canSaveCases}
      now={new Date().toISOString()}
    />
  );
}

async function pageContext(projectId: string) {
  if (!(await sandboxesEnabledForProject(projectId))) notFound();
  if (!isDbConfigured()) {
    return {
      unavailable: (
        <DatabaseUnavailable title="Sandboxes">
          Sandboxes become available once setup finishes.
        </DatabaseUnavailable>
      ),
    };
  }
  const session = await getSessionContext();
  if (!session) redirect("/");
  const { project, role } = await getProjectScope(projectId);
  const restricted = await isRestrictedBySupportSession();
  // "Save as eval case" writes an eval case: it needs the evals flag and a write.
  const canSaveCases = !restricted && (await evalsEnabledForProject(project.id));
  const server = {
    configured: () => sandboxProviderConfigured(),
    problems: () =>
      configurationProblems(
        sandboxProviderKind(getConfig(), process.env.NODE_ENV),
        sealedSecretsKey(),
      ),
  };
  return {
    project,
    canEdit: role === "admin" && !restricted,
    canSaveCases,
    db: getDb(),
    server,
  };
}
