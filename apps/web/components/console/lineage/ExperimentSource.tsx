import { SourceLink } from "@/components/console/lineage/SourceLink";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { experimentRef } from "@/lib/views/lineage/refs";
import { sourceOf } from "@/lib/views/lineage/resolve";
import type { LineageRef } from "@/lib/views/lineage/types";
import { stageSpineEnabled } from "@/lib/views/stage-spine-flag";

/**
 * "From insight …" above an experiment (RC-45, behind `FF_STAGE_SPINE`).
 * An experiment is named by the SDK, so its insight is only what someone
 * recorded when they started it from one (RC-43's `create_experiment`);
 * otherwise it says it has none. A failed read shows nothing. Owned (ADR-0030):
 * the flag is read from the environment.
 */
export async function ExperimentSource({ projectId, name }: { projectId: string; name: string }) {
  if (!stageSpineEnabled()) return null;
  const source = await loadOrFallback<LineageRef | null | "failed">({
    operation: "experiment_lineage",
    distinctId: `project:${projectId}`,
    fallback: "failed",
    load: () =>
      withStatementTimeout((db) => sourceOf(experimentRef(name), { projectId, db }), {
        operation: "experiment_lineage",
      }),
  });
  if (source === "failed") return null;
  return (
    <SourceLink
      source={source}
      projectId={projectId}
      empty="Not linked to an insight yet"
      className="mb-4"
    />
  );
}
