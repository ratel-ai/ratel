import type { Fix } from "@/lib/views/fixes/types";
import { fixSourceRef } from "@/lib/views/lineage/refs";
import { SourceLink } from "./SourceLink";

/**
 * "From insight …" on a fix's panel: the worst
 * issue it resolves, else its intent or task (`fixSourceRef`). Read from the
 * fix already loaded; nothing is fetched.
 */
export function FixSource({
  projectId,
  fix,
}: {
  projectId: string;
  fix: Pick<Fix, "issues" | "intent" | "subject">;
}) {
  return (
    <SourceLink
      source={fixSourceRef(projectId, fix)}
      projectId={projectId}
      empty="Not linked to an insight"
    />
  );
}
