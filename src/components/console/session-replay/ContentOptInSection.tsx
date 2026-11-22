import { Section } from "@ratel/design-system/section";
import { getSessionContext } from "@/lib/platform/session";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import { ContentOptIn } from "./ContentOptIn";

/** The content opt-in section of Settings > General. */
export async function ContentOptInSection({
  projectId,
  role,
}: {
  projectId: string;
  role: string;
}) {
  const session = await getSessionContext();
  if (!session) return null;
  return (
    <Section title="Session replay content">
      <ContentOptIn
        projectId={projectId}
        readContent={await contentOptIn(projectId)}
        canChange={role === "admin"}
      />
    </Section>
  );
}
