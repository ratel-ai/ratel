"use client";

import type { Fix } from "@/lib/views/fixes/types";
import { fixSourceRef } from "@/lib/views/lineage/refs";
import { SourceLink } from "./SourceLink";
import { useStageSpine } from "./stage-spine-context";

/**
 * "From insight …" on a fix's panel, behind `cloud-stage-spine`: the worst
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
  const on = useStageSpine();
  if (!on) return null;
  return (
    <SourceLink
      source={fixSourceRef(projectId, fix)}
      projectId={projectId}
      empty="Not linked to an insight"
    />
  );
}
