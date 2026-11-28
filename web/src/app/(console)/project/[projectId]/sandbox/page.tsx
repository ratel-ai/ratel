import { redirect } from "next/navigation";
import { SandboxView } from "@/components/console/sandboxes/SandboxView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { publicBaseUrl } from "@/lib/platform/public-url";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { createDrizzleRunStore } from "@/lib/views/sandboxes/adapters/drizzle-run-store";
import { createDrizzleSecretStore } from "@/lib/views/sandboxes/adapters/drizzle-secret-store";
import { createDrizzleVersionStore } from "@/lib/views/sandboxes/adapters/drizzle-version-store";
import { sandboxProviderConfigured } from "@/lib/views/sandboxes/adapters/provider-from-env";
import { loadSandboxPage } from "@/lib/views/sandboxes/page-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ratel sandbox" };

/** The project's sandbox: versions, secrets and one run by hand. */
export default async function SandboxPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
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
  const canEdit = role === "admin" && !(await isRestrictedBySupportSession());
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
      }),
    { attributes: { "project.id": project.id } },
  );
  return <SandboxView model={model} ratelUrl={publicBaseUrl()} now={new Date().toISOString()} />;
}
