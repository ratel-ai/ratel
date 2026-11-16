import { Section } from "@ratel/design-system/section";
import { getSessionContext } from "@/lib/platform/session";
import { sessionReplayEnabledForActor } from "@/lib/views/session-replay/gate";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import { ContentOptIn } from "./ContentOptIn";

/** The content opt-in section of Settings > General, or nothing while `cloud-session-replay` is off for the reader. */
export async function ContentOptInSection({
  projectId,
  role,
}: {
  projectId: string;
  role: string;
}) {
  const session = await getSessionContext();
  if (!session || !(await sessionReplayEnabledForActor(projectId, session.user.externalId)))
    return null;
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
