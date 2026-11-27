import { sandboxSectionPage } from "../../sandbox-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Configuration · Sandboxes" };

/** The parsed ratel.yaml of a version of the sandbox: `?version=<id>`, else the newest. */
export default async function SandboxConfigurationPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; name: string }>;
  searchParams: Promise<{ version?: string | string[] }>;
}) {
  const { projectId, name } = await params;
  const { version } = await searchParams;
  return sandboxSectionPage(
    projectId,
    name,
    "configuration",
    typeof version === "string" ? version : null,
  );
}
