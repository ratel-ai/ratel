import { sandboxSectionPage } from "../../sandbox-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Secrets · Sandboxes" };

export default async function SandboxSecretsPage({
  params,
}: {
  params: Promise<{ projectId: string; name: string }>;
}) {
  const { projectId, name } = await params;
  return sandboxSectionPage(projectId, name, "secrets");
}
