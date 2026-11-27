import { sandboxSectionPage } from "../../sandbox-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Versions · Sandboxes" };

export default async function SandboxVersionsPage({
  params,
}: {
  params: Promise<{ projectId: string; name: string }>;
}) {
  const { projectId, name } = await params;
  return sandboxSectionPage(projectId, name, "versions");
}
