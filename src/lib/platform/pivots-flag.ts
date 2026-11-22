import type { FlagSubject } from "@/lib/contracts/feature-flags";
import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";
import { getLogger } from "@/lib/platform/logger";

/**
 * `FF_PIVOTS`: pivots (ratel-cloud RC-863 and its milestones, upstream's `cloud-pivots`). A
 * project slices its traces by attributes it chooses. On, Settings > Pivots exists, OTLP ingest
 * keeps the configured pivot keys on span rows, and the summary sweep and the refill write `dims`
 * on trace summaries. Off, the page does not exist and ingest and the sweep write what they wrote
 * before.
 *
 * A core switch (ADR-0030), off by default. Without the edition's flags port it is one switch for
 * the deployment, read from the environment (or `RATEL_EXPERIMENTAL_FEATURES` in the open-source
 * edition); with it, the edition decides it for the project (`featureEnabled`). It lives in the
 * platform layer because ingest, the summary sweep and the console read it. Owned (ADR-0030): it
 * keeps upstream's names (`lib/pivots/flag.ts`), so every caller stays upstream's; the last
 * argument is the flag deps instead of the Cloud ingest flag deps.
 */
export const PIVOTS_FLAG = "FF_PIVOTS" as const;

/** `FF_PIVOTS` for a project, by id only: what the summary sweep and the refill ask (RC-968). */
export type PivotsEnabledLookup = (projectId: string) => Promise<boolean>;

export interface PivotsEnabledLookupDeps {
  /** The flag deps; absent, the composition's. */
  flag?: Partial<FeatureFlagDeps>;
  /** The decision itself; absent, `pivotsOn` for the project. A test throws here. */
  decide?: (projectId: string) => Promise<boolean>;
  ttlMs?: number;
  now?: () => number;
}

export const PIVOTS_ENABLED_TTL_MS = 60_000;

/**
 * The organization a caller holds when it asks for a project: upstream's ingest flag organization,
 * or any record with an `id`. Only its id narrows the subject.
 */
export type PivotsFlagOrganization = {
  readonly id: string;
  readonly [key: string]: unknown;
} | null;

const logger = getLogger("pivots/flag");

/** Whether pivots are on for this subject (a project, at least). Never throws: a failed decision is off. */
export function pivotsOn(
  subject: FlagSubject,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled(PIVOTS_FLAG, subject, deps);
}

/**
 * Whether the switch is on for the project. The organization (upstream's ingest flag
 * organization, or any record with an `id`) narrows the subject when the caller holds it. Never
 * throws: a failed decision is off.
 */
export function pivotsEnabled(
  projectId: string,
  organization: PivotsFlagOrganization | string = null,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  const organizationId = organizationIdOf(organization);
  return pivotsOn(organizationId ? { projectId, organizationId } : { projectId }, deps);
}

/**
 * A cached {@link PivotsEnabledLookup}: one decision per project a minute, shared while in
 * flight. Never throws: a failed decision is off and is not kept.
 */
export function createPivotsEnabledLookup(deps: PivotsEnabledLookupDeps = {}): PivotsEnabledLookup {
  const decide = deps.decide ?? ((projectId: string) => pivotsOn({ projectId }, deps.flag ?? {}));
  const ttlMs = deps.ttlMs ?? PIVOTS_ENABLED_TTL_MS;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; enabled: Promise<boolean> }>();
  return (projectId) => {
    const cached = cache.get(projectId);
    if (cached && now() - cached.at < ttlMs) return cached.enabled;
    const enabled: Promise<boolean> = decide(projectId).catch((err: unknown) => {
      logger.error({ err, project_id: projectId }, "pivots flag failed");
      if (cache.get(projectId)?.enabled === enabled) cache.delete(projectId);
      return false;
    });
    cache.set(projectId, { at: now(), enabled });
    return enabled;
  };
}

/** The process-wide lookup the sweep and the refill use. */
export const defaultPivotsEnabledLookup: PivotsEnabledLookup = createPivotsEnabledLookup();

/** The organization's id when the caller passed one (upstream passes its flag organization). */
function organizationIdOf(organization: unknown): string | undefined {
  if (typeof organization === "string") return organization || undefined;
  if (typeof organization !== "object" || organization === null || !("id" in organization)) {
    return undefined;
  }
  return typeof organization.id === "string" && organization.id ? organization.id : undefined;
}
