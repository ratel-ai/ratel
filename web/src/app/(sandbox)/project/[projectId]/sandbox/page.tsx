import { notFound, redirect } from "next/navigation";
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
import { createDrizzleSecretStore } from "@/lib/views/sandboxes/adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "@/lib/views/sandboxes/adapters/drizzle-version-store";
import {
  sandboxProviderConfigured,
  sandboxProviderKind,
} from "@/lib/views/sandboxes/adapters/provider-from-env";
import { sandboxesEnabledForProject } from "@/lib/views/sandboxes/gate";
import { configurationProblems, loadSandboxPage } from "@/lib/views/sandboxes/page-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ratel sandbox" };

/** The project's sandbox: versions, secrets and one run by hand (the `sandboxes` flag). */
export default async function SandboxPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  // Next renders a page next to its layout: the layout's 404 does not stop this data.
  if (!(await sandboxesEnabledForProject(projectId))) notFound();
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Ratel sandbox">
        Ratel sandbox becomes available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const session = await getSessionContext();
  if (!session) redirect("/");
  const { project, role } = await getProjectScope(projectId);
  const restricted = await isRestrictedBySupportSession();
  const canEdit = role === "admin" && !restricted;
  // "Save as case" writes an eval case: it needs the evals flag and a write.
  const canSaveCases = !restricted && (await evalsEnabledForProject(project.id));
  const db = getDb();
  const model = await withFeatureSpan(
    "sandboxes",
    "load_page",
    () =>
      loadSandboxPage(project.id, canEdit, {
        versions: createDrizzleVersionStore(db),
        secrets: createDrizzleSecretStore(db),
        runs: createDrizzleRunStore(db),
        configured: () => sandboxProviderConfigured(),
        problems: () =>
          configurationProblems(
            sandboxProviderKind(getConfig(), process.env.NODE_ENV),
            sealedSecretsKey(),
          ),
      }),
    { attributes: { "project.id": project.id } },
  );
  return (
    <SandboxView
      model={model}
      ratelUrl={publicBaseUrl()}
      canSaveCases={canSaveCases}
      now={new Date().toISOString()}
    />
  );
}
