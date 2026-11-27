import { sandboxSectionPage } from "../sandbox-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Playground · Sandboxes" };

export default async function SandboxPlaygroundPage({
  params,
}: {
  params: Promise<{ projectId: string; name: string }>;
}) {
  const { projectId, name } = await params;
  return sandboxSectionPage(projectId, name, "playground");
}
