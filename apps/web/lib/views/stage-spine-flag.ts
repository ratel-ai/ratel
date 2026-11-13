import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";

/**
 * The stage spine (the rail grouped into Monitor, Insights, Improve and Ship, the Ship page and
 * the "From …" lineage links) is off unless `FF_STAGE_SPINE` is set (or, in the open-source
 * edition, `RATEL_EXPERIMENTAL_FEATURES`): without it the Ship page and the lineage endpoint are a 404 and no page shows a source link or a shipped mark. Replaces
 * upstream's `cloud-stage-spine` flag.
 */
export function stageSpineEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return experimentalFeatureEnabled("FF_STAGE_SPINE", env);
}
