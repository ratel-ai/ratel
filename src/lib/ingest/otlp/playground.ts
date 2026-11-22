import { attrString } from "@/lib/ingest/otlp/anyvalue";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import { sandboxesEnabledForOrganization } from "@/lib/platform/sandboxes-flag";

/**
 * Playground runs (spec §10): the runner exports them with the resource
 * attribute `deployment.environment.name = playground`. They are normal traces
 * and stay in `otel_spans` (Traces), but with `FF_SANDBOXES` on, ingest leaves
 * them out of the cost rows (`events` / `event_metrics`) and the Agent health
 * turn ledger, so a playground session never moves a project's cost or health.
 *
 * Owned (ADR-0030): upstream's `lib/sandboxes/playground.ts`, in the ingest layer beside the span
 * ingest that reads it; the switch is the core's `FF_SANDBOXES`
 * (`lib/platform/sandboxes-flag.ts`), not the Cloud ingest flag evaluator.
 */

export const PLAYGROUND_ENVIRONMENT = "playground";
const ENVIRONMENT_KEY = "deployment.environment.name";

/** `FF_SANDBOXES` for a project, given its organization. Never throws. */
export type SandboxesFlag = (projectId: string, organization: unknown) => Promise<boolean>;

/** Which spans of a batch ingest keeps out of cost and Agent health. */
export type PlaygroundExclusion = (span: DecodedSpan) => boolean;

const NONE: PlaygroundExclusion = () => false;

/**
 * The batch's playground filter. The flag is read only when the batch has a
 * playground span; off, or with none, nothing is left out.
 */
export async function playgroundExclusion(
  spans: readonly DecodedSpan[],
  projectId: string,
  organization: unknown,
  isEnabled: SandboxesFlag = sandboxesEnabledForOrganization,
): Promise<PlaygroundExclusion> {
  if (!spans.some(isPlaygroundSpan)) return NONE;
  return (await isEnabled(projectId, organization)) ? isPlaygroundSpan : NONE;
}

/** The span's environment is `playground`: a span attribute wins over the resource's, like the environment facet. */
export function isPlaygroundSpan(
  span: Pick<DecodedSpan, "attributes" | "resourceAttributes">,
): boolean {
  const environment =
    attrString(span.attributes, ENVIRONMENT_KEY) ??
    attrString(span.resourceAttributes, ENVIRONMENT_KEY);
  return environment === PLAYGROUND_ENVIRONMENT;
}
